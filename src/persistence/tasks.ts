import { isTerminalState } from '@coderax/contracts';
import type { TaskPatch, TaskRecord } from '../domain.js';
import { isAuthorizedGeneration } from '../execution/lease.js';
import { redactContent } from '../observability/redact.js';

/**
 * A task record is durable and readable by every replica, so failure text and a
 * result summary are scrubbed before they are written. Adapters and providers
 * write both, and neither is trusted to have removed a credential first.
 */
export function sanitizeTaskPatch(patch: TaskPatch): TaskPatch {
  const next: TaskPatch = { ...patch };
  if (next.failure?.detail !== undefined) {
    next.failure = { ...next.failure, detail: redactContent(next.failure.detail) };
  }
  if (next.result?.summary !== undefined) {
    next.result = { ...next.result, summary: redactContent(next.result.summary) };
  }
  return next;
}

export type CreateTaskResult =
  | { ok: true; task: TaskRecord }
  | { ok: false; reason: 'exists' | 'conversation_busy' };

export type FencedWriteResult =
  | { applied: true; task: TaskRecord }
  | { applied: false; reason: 'not_found' | 'superseded' | 'terminal' | 'guard_rejected' };

/**
 * The only writer of task state.
 *
 * `updateFenced` applies a patch only when the caller still holds the task's
 * unique run token and the task is not already terminal. That is the invariant
 * that stops an expired execution from overwriting a newer execution's state,
 * and it is enforced here rather than trusted to each caller.
 */
export type TaskRepository = {
  create: (task: TaskRecord) => Promise<CreateTaskResult>;
  get: (taskId: string) => Promise<TaskRecord | null>;
  updateFenced: (
    input: {
      taskId: string;
      token: string;
      patch: TaskPatch;
      /** Optional atomic guard for the cancellation/suspension handoff. */
      guard?: 'not_cancel_requested' | 'not_awaiting_approval';
    },
  ) => Promise<FencedWriteResult>;
  /**
   * Settles a task that was never claimed (no run token). It refuses anything a
   * generation owns, so it cannot be used to bypass fencing.
   */
  abandon: (input: { taskId: string; patch: TaskPatch }) => Promise<boolean>;
  /** Claim a new generation for resume/retry; refuses a live task. */
  takeHandoff: (taskId: string, generation: number, token: string, leaseExpiresAt: string) => Promise<TaskRecord | null>;
  claimScheduledRetry: (taskId: string, generation: number) => Promise<boolean>;
  reissue: (input: {
    taskId: string;
    token: string;
    now: string;
    leaseExpiresAt: string;
    /** States this caller is authorized to replace; checked atomically. */
    from: TaskRecord['state'][];
  }) => Promise<FencedWriteResult>;
  /**
   * Allocates the next durable event sequence for the generation that still
   * holds the row's fence. The token is part of the increment itself, so a
   * superseded generation gets `null` rather than a number it could write over
   * the new owner's events. A settled row keeps its token, which is what lets a
   * generation append its own terminal event after the state write.
   */
  allocateSeq: (input: { taskId: string; token: string }) => Promise<number | null>;
  /**
   * Raises the durable head to an externally adopted sequence. It never lowers
   * the head, so adopting a replayed event cannot make the allocator hand out a
   * sequence the log already contains.
   */
  adoptSeq: (input: { taskId: string; seq: number }) => Promise<void>;
  listByConversation: (conversationId: string) => Promise<TaskRecord[]>;
  /** Tasks that are not terminal, used by startup ownership verification. */
  listUnsettled: () => Promise<TaskRecord[]>;
  listByOwner: (ownerId: string) => Promise<TaskRecord[]>;
};

export function createTaskRepository(): TaskRepository {
  const tasks = new Map<string, TaskRecord>();
  const activeByConversation = new Map<string, string>();

  function settle(task: TaskRecord): void {
    const active = activeByConversation.get(task.conversationId);
    if (active === task.taskId) {
      activeByConversation.delete(task.conversationId);
    }
  }

  return {
    create: async (task) => {
      if (tasks.has(task.taskId)) {
        return { ok: false, reason: 'exists' };
      }
      const active = activeByConversation.get(task.conversationId);
      if (active && active !== task.taskId) {
        const live = tasks.get(active);
        if (live && !isTerminalState(live.state)) {
          return { ok: false, reason: 'conversation_busy' };
        }
      }
      tasks.set(task.taskId, {
        ...task,
        ...sanitizeTaskPatch({ failure: task.failure, result: task.result }),
        eventSeq: task.eventSeq ?? 0,
      });
      if (!isTerminalState(task.state)) {
        activeByConversation.set(task.conversationId, task.taskId);
      }
      return { ok: true, task: { ...task } };
    },
    get: async (taskId) => {
      const task = tasks.get(taskId);
      return task ? { ...task } : null;
    },
    updateFenced: async ({ taskId, token, patch: rawPatch, guard }) => {
      const patch = sanitizeTaskPatch(rawPatch);
      const task = tasks.get(taskId);
      if (!task) return { applied: false, reason: 'not_found' };
      if (!isAuthorizedGeneration(task.runToken, token)) {
        return { applied: false, reason: 'superseded' };
      }
      if (isTerminalState(task.state)) {
        return { applied: false, reason: 'terminal' };
      }
      if ((guard === 'not_cancel_requested' && task.cancelRequested) ||
          (guard === 'not_awaiting_approval' && task.state === 'awaiting_approval')) {
        return { applied: false, reason: 'guard_rejected' };
      }
      const next: TaskRecord = { ...task, ...patch, runToken: task.runToken };
      tasks.set(taskId, next);
      if (isTerminalState(next.state)) {
        settle(next);
      }
      return { applied: true, task: { ...next } };
    },
    abandon: async ({ taskId, patch }) => {
      const task = tasks.get(taskId);
      if (!task || task.runToken !== null) return false;
      const next: TaskRecord = { ...task, ...patch };
      tasks.set(taskId, next);
      if (isTerminalState(next.state)) settle(next);
      return true;
    },
    allocateSeq: async ({ taskId, token }) => {
      const task = tasks.get(taskId);
      if (!task || task.runToken !== token) return null;
      const next: TaskRecord = { ...task, eventSeq: (task.eventSeq ?? 0) + 1 };
      tasks.set(taskId, next);
      return next.eventSeq;
    },
    adoptSeq: async ({ taskId, seq }) => {
      const task = tasks.get(taskId);
      if (!task) return;
      tasks.set(taskId, { ...task, eventSeq: Math.max(task.eventSeq ?? 0, seq) });
    },
    takeHandoff: async (taskId, generation, token, leaseExpiresAt) => {
      const task = tasks.get(taskId);
      if (!task?.handoffPending || task.generation !== generation ||
          (task.state !== 'queued' && task.state !== 'interrupted')) return null;
      const next: TaskRecord = { ...task, state: 'queued', failure: null, generation: generation + 1, runToken: token, leaseExpiresAt };
      tasks.set(taskId, next);
      activeByConversation.set(task.conversationId, taskId);
      return { ...next };
    },
    claimScheduledRetry: async (taskId, generation) => {
      const task = tasks.get(taskId);
      if (!task || task.state !== 'failed' || task.generation !== generation) return false;
      tasks.set(taskId, { ...task, scheduleRetryClaimed: true });
      return true;
    },
    reissue: async ({ taskId, token, now, leaseExpiresAt, from }) => {
      const task = tasks.get(taskId);
      if (!task) return { applied: false, reason: 'not_found' };
      if (task.scheduleRetryClaimed || !from.includes(task.state)) {
        return { applied: false, reason: 'superseded' };
      }
      const next: TaskRecord = {
        ...task,
        state: 'queued',
        generation: task.generation + 1,
        checkpoint: { ...task.checkpoint, text: '' },
        runToken: token,
        updatedAt: now,
        leaseExpiresAt,
        cancelRequested: false,
        failure: null,
        result: null,
      };
      tasks.set(taskId, next);
      activeByConversation.set(next.conversationId, next.taskId);
      return { applied: true, task: { ...next } };
    },
    listByConversation: async (conversationId) =>
      [...tasks.values()]
        .filter((task) => task.conversationId === conversationId)
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
        .map((task) => ({ ...task })),
    listUnsettled: async () =>
      [...tasks.values()].filter((task) => !isTerminalState(task.state)).map((t) => ({ ...t })),
    listByOwner: async (ownerId) =>
      [...tasks.values()].filter((task) => task.ownerId === ownerId).map((t) => ({ ...t })),
  };
}
