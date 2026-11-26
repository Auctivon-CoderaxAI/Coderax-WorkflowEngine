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
  messageId: () => string;
  eventId: () => string;
  /** A unique fencing token per claim; never a counter that can be reused. */
  runToken: () => string;
  requestId: () => string;
  receipt: () => string;
  /** A persistent game project identity; URL-safe and unguessable. */
  gameId: () => string;
  /** A gaming-agent session identity. */
  sessionId: () => string;
};

export function createIdGenerator(): IdGenerator {
  return {
    conversationId: () => `conv_${randomUUID()}`,
    taskId: () => `task_${randomUUID()}`,
    messageId: () => `msg_${randomUUID()}`,
    eventId: () => `evt_${randomUUID()}`,
    runToken: () => `run_${randomUUID()}`,
    requestId: () => `req_${randomUUID()}`,
    receipt: () => `rcpt_${randomUUID()}`,
    gameId: () => `game_${randomUUID()}`,
    sessionId: () => `sess_${randomUUID()}`,
  };
}
