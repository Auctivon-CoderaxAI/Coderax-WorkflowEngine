import { TERMINAL_TASK_STATES, isTerminalState } from '@coderax/contracts';
import type { AgentId, DataMode, TaskState } from '@coderax/contracts';
import type { TaskPatch, TaskRecord } from '../domain.js';
import { isAuthorizedGeneration } from '../execution/lease.js';
import { clampLimit, decodeCursor, encodeCursor } from './pagination.js';

export type CreateTaskResult =
  | { ok: true; task: TaskRecord }
  | { ok: false; reason: 'exists' | 'conversation_busy' };

export type FencedWriteResult =
  | { applied: true; task: TaskRecord }
  | { applied: false; reason: 'not_found' | 'superseded' | 'terminal' };

export type TaskPageInput = {
  ownerId: string;
  limit?: number;
  cursor?: string;
  state?: TaskState;
  conversationId?: string;
  agent?: AgentId;
  mode?: DataMode;
};

export type TaskPage = {
  tasks: TaskRecord[];
  total: number;
  nextCursor?: string;
};

export type TaskStateCounts = Record<TaskState, number>;

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
  /** Owner-scoped, newest first, bounded, with an opaque cursor. */
  listPage: (input: TaskPageInput) => Promise<TaskPage>;
  /** Engine-wide counters for the operational read model. */
  countByState: () => Promise<TaskStateCounts>;
  /** Authorized cascade for deleting one conversation. */
  deleteByConversation: (ownerId: string, conversationId: string) => Promise<number>;
};

const STATES: readonly TaskState[] = [
  'queued',
  'running',
  'awaiting_approval',
  ...TERMINAL_TASK_STATES,
];

function emptyCounts(): TaskStateCounts {
  return {
    queued: 0,
    running: 0,
    awaiting_approval: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    interrupted: 0,
  };
}

function matches(task: TaskRecord, input: TaskPageInput): boolean {
  return (
    task.ownerId === input.ownerId &&
    (input.state === undefined || task.state === input.state) &&
    (input.conversationId === undefined || task.conversationId === input.conversationId) &&
    (input.agent === undefined || task.agent === input.agent) &&
    (input.mode === undefined || task.mode === input.mode)
  );
}

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
    listPage: async (input) => {
      const limit = clampLimit(input.limit);
      const cursor = input.cursor ? decodeCursor(input.cursor) : null;
      const matching = [...tasks.values()]
        .filter((task) => matches(task, input))
        .sort(
          (left, right) =>
            right.updatedAt.localeCompare(left.updatedAt) ||
            right.taskId.localeCompare(left.taskId),
        );
      const after = cursor
        ? matching.filter(
            (task) =>
              task.updatedAt < cursor.at || (task.updatedAt === cursor.at && task.taskId < cursor.id),
          )
        : matching;
      const page = after.slice(0, limit);
      const hasMore = after.length > limit;
      return {
        tasks: page.map((task) => ({ ...task })),
        total: matching.length,
        ...(hasMore && page.length > 0
          ? { nextCursor: encodeCursor(page[page.length - 1]!.updatedAt, page[page.length - 1]!.taskId) }
          : {}),
      };
    },
    countByState: async () => {
      const counts = emptyCounts();
      for (const task of tasks.values()) counts[task.state] += 1;
      return counts;
    },
    deleteByConversation: async (ownerId, conversationId) => {
      let deleted = 0;
      for (const [taskId, task] of tasks) {
        if (task.ownerId === ownerId && task.conversationId === conversationId) {
          tasks.delete(taskId);
          settle(task);
          deleted += 1;
        }
      }
      return deleted;
    },
  };
}

export { STATES };
