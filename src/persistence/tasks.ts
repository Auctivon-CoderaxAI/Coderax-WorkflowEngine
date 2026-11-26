import { isTerminalState } from '@coderax/contracts';
import type { TaskPatch, TaskRecord } from '../domain.js';
import { isAuthorizedGeneration } from '../execution/lease.js';

export type CreateTaskResult =
  | { ok: true; task: TaskRecord }
  | { ok: false; reason: 'exists' | 'conversation_busy' };

export type FencedWriteResult =
  | { applied: true; task: TaskRecord }
  | { applied: false; reason: 'not_found' | 'superseded' | 'terminal' | 'cancel_requested' };

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
    input: { taskId: string; token: string; patch: TaskPatch },
  ) => Promise<FencedWriteResult>;
  /**
   * Settles a task that was never claimed (no run token). It refuses anything a
   * generation owns, so it cannot be used to bypass fencing.
   */
  abandon: (input: { taskId: string; patch: TaskPatch }) => Promise<boolean>;
  /**
   * Claims a new generation for resume/retry. `keepCompletedSteps` is what
   * separates the two: a resume continues the plan, a retry replays all of it.
   */
  reissue: (input: {
    taskId: string;
    token: string;
    expected?: Pick<TaskRecord, 'state' | 'generation'>;
    cancelSuspended?: boolean;
    now: string;
    leaseExpiresAt: string;
    keepCompletedSteps?: boolean;
  }) => Promise<FencedWriteResult>;
  listByConversation: (conversationId: string) => Promise<TaskRecord[]>;
  /** Tasks that are not terminal, used by startup ownership verification. */
  listUnsettled: () => Promise<TaskRecord[]>;
  /** Most recently settled tasks, used to repair derived records after a crash. */
  listSettled: (limit: number) => Promise<TaskRecord[]>;
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
      tasks.set(task.taskId, { ...task });
      if (!isTerminalState(task.state)) {
        activeByConversation.set(task.conversationId, task.taskId);
      }
      return { ok: true, task: { ...task } };
    },
    get: async (taskId) => {
      const task = tasks.get(taskId);
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
      if (patch.state === 'awaiting_approval' && task.cancelRequested) {
        return { applied: false, reason: 'cancel_requested' };
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
    reissue: async ({
      taskId,
      token,
      now,
      leaseExpiresAt,
      expected,
      cancelSuspended,
      keepCompletedSteps = true,
    }) => {
      const task = tasks.get(taskId);
      if (!task) return { applied: false, reason: 'not_found' };
      if ((cancelSuspended && task.state !== 'awaiting_approval') ||
          (expected && (expected.state !== task.state || expected.generation !== task.generation)) ||
          (!isTerminalState(task.state) && task.state !== 'awaiting_approval')) {
        return { applied: false, reason: 'superseded' };
      }
      const checkpoint = task.checkpoint ?? { completedSteps: [], text: '' };
      const resumeText = keepCompletedSteps ? (checkpoint.resumeText ?? checkpoint.text) : '';
      const next: TaskRecord = {
        ...task,
        state: cancelSuspended ? 'cancelled' : 'queued',
        generation: task.generation + 1,
        // An approval decision keeps the suspended checkpoint as it stands; a
        // resume continues the plan, while a retry replays all of it.
        checkpoint: expected?.state === 'awaiting_approval'
          ? task.checkpoint
          : keepCompletedSteps
            ? {
                ...task.checkpoint,
                completedSteps: [...checkpoint.completedSteps],
                text: '',
                ...(resumeText ? { resumeText } : {}),
              }
            : { completedSteps: [], text: '' },
        runToken: token,
        updatedAt: now,
        leaseExpiresAt,
        cancelRequested: cancelSuspended ?? false,
        failure: null,
        result: null,
      };
      tasks.set(taskId, next);
      if (cancelSuspended) settle(next);
      else activeByConversation.set(next.conversationId, next.taskId);
      return { applied: true, task: { ...next } };
    },
    listByConversation: async (conversationId) =>
      [...tasks.values()]
        .filter((task) => task.conversationId === conversationId)
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
        .map((task) => ({ ...task })),
    listUnsettled: async () =>
      [...tasks.values()].filter((task) => !isTerminalState(task.state)).map((t) => ({ ...t })),
    listSettled: async (limit) =>
      [...tasks.values()]
        .filter((task) => isTerminalState(task.state))
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .slice(0, Math.max(1, limit))
        .map((task) => ({ ...task })),
    listByOwner: async (ownerId) =>
      [...tasks.values()].filter((task) => task.ownerId === ownerId).map((t) => ({ ...t })),
  };
}
