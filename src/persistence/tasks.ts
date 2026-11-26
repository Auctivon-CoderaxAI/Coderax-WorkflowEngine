import { isTerminalState } from '@coderax/contracts';
import type { TaskPatch, TaskRecord } from '../domain.js';
import { isAuthorizedGeneration } from '../execution/lease.js';

export type CreateTaskResult =
  | { ok: true; task: TaskRecord }
  | { ok: false; reason: 'exists' | 'conversation_busy' }
  /** The same owner and idempotency key already created this task. */
  | { ok: false; reason: 'idempotent'; task: TaskRecord };

export type FencedWriteResult =
  | { applied: true; task: TaskRecord }
  | { applied: false; reason: 'not_found' | 'superseded' | 'terminal' };

export type CreateTaskOptions = {
  /** Scoped by owner; the same key returns the task the first submission made. */
  idempotencyKey?: string;
};

/**
 * The only writer of task state.
 *
 * `updateFenced` applies a patch only when the caller still holds the task's
 * unique run token and the task is not already terminal. That is the invariant
 * that stops an expired execution from overwriting a newer execution's state,
 * and it is enforced here rather than trusted to each caller.
 */
export type TaskRepository = {
  create: (task: TaskRecord, options?: CreateTaskOptions) => Promise<CreateTaskResult>;
  get: (taskId: string) => Promise<TaskRecord | null>;
  /** Resolves a replayed submission without creating a second task. */
  findByIdempotencyKey: (ownerId: string, key: string) => Promise<TaskRecord | null>;
  updateFenced: (
    input: { taskId: string; token: string; patch: TaskPatch },
  ) => Promise<FencedWriteResult>;
  /**
   * Settles a task that was never claimed (no run token). It refuses anything a
   * generation owns, so it cannot be used to bypass fencing.
   */
  abandon: (input: { taskId: string; patch: TaskPatch }) => Promise<boolean>;
  /** Claim a new generation for resume/retry; refuses a live task. */
  reissue: (input: {
    taskId: string;
    token: string;
    now: string;
    leaseExpiresAt: string;
  }) => Promise<FencedWriteResult>;
  listByConversation: (conversationId: string) => Promise<TaskRecord[]>;
  /** Tasks that are not terminal, used by startup ownership verification. */
  listUnsettled: () => Promise<TaskRecord[]>;
  listByOwner: (ownerId: string) => Promise<TaskRecord[]>;
};

function idempotencyKey(ownerId: string, key: string): string {
  // NUL cannot appear in either component (identifiers are trimmed text and the
  // key is URL-safe), so the pairing is unambiguous.
  return JSON.stringify([ownerId, key]);
}

export function createTaskRepository(): TaskRepository {
  const tasks = new Map<string, TaskRecord>();
  const activeByConversation = new Map<string, string>();
  const idempotency = new Map<string, string>();

  function settle(task: TaskRecord): void {
    const active = activeByConversation.get(task.conversationId);
    if (active === task.taskId) {
      activeByConversation.delete(task.conversationId);
    }
  }

  return {
    create: async (task, options) => {
      if (options?.idempotencyKey) {
        const existingId = idempotency.get(idempotencyKey(task.ownerId, options.idempotencyKey));
        const existing = existingId ? tasks.get(existingId) : undefined;
        if (existing) {
          return { ok: false, reason: 'idempotent', task: { ...existing } };
        }
      }
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
      tasks.set(task.taskId, { ...task });
      if (options?.idempotencyKey) {
        idempotency.set(idempotencyKey(task.ownerId, options.idempotencyKey), task.taskId);
      }
      if (!isTerminalState(task.state)) {
        activeByConversation.set(task.conversationId, task.taskId);
      }
      return { ok: true, task: { ...task } };
    },
    get: async (taskId) => {
      const task = tasks.get(taskId);
      return task ? { ...task } : null;
    },
    findByIdempotencyKey: async (ownerId, key) => {
      const taskId = idempotency.get(idempotencyKey(ownerId, key));
      const task = taskId ? tasks.get(taskId) : undefined;
      return task ? { ...task } : null;
    },
    updateFenced: async ({ taskId, token, patch }) => {
      const task = tasks.get(taskId);
      if (!task) return { applied: false, reason: 'not_found' };
      if (!isAuthorizedGeneration(task.runToken, token)) {
        return { applied: false, reason: 'superseded' };
      }
      if (isTerminalState(task.state)) {
        return { applied: false, reason: 'terminal' };
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
    reissue: async ({ taskId, token, now, leaseExpiresAt }) => {
      const task = tasks.get(taskId);
      if (!task) return { applied: false, reason: 'not_found' };
      if (!isTerminalState(task.state) && task.state !== 'awaiting_approval') {
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

export { idempotencyKey as taskIdempotencyKey };
