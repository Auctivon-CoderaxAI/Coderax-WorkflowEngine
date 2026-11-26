import { randomUUID } from 'node:crypto';

export type Clock = {
  now: () => Date;
  iso: () => string;
};

export function createClock(): Clock {
  return {
    now: () => new Date(),
    iso: () => new Date().toISOString(),
  };
}

export type IdGenerator = {
  conversationId: () => string;
  taskId: () => string;
  teamId: () => string;
  messageId: () => string;
  eventId: () => string;
  /** A unique fencing token per claim; never a counter that can be reused. */
  runToken: () => string;
  /** Names one supervised attempt, distinct from the task it executes. */
  executionId: () => string;
  requestId: () => string;
  receipt: () => string;
};

export function createIdGenerator(): IdGenerator {
  return {
    conversationId: () => `conv_${randomUUID()}`,
    taskId: () => `task_${randomUUID()}`,
    teamId: () => `team_${randomUUID()}`,
    messageId: () => `msg_${randomUUID()}`,

    eventId: () => `evt_${randomUUID()}`,
    runToken: () => `run_${randomUUID()}`,
    executionId: () => `exec_${randomUUID()}`,
    requestId: () => `req_${randomUUID()}`,
    receipt: () => `rcpt_${randomUUID()}`,
  };
}
