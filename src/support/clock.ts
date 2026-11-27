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
  scheduleId: () => string;
  executionId: () => string;
  noticeId: () => string;
  /** A unique fencing token per claim; never a counter that can be reused. */
  runToken: () => string;
  requestId: () => string;
  receipt: () => string;
  browserSessionId: () => string;
  browserArtifactId: () => string;
};

export function createIdGenerator(): IdGenerator {
  return {
    conversationId: () => `conv_${randomUUID()}`,
    taskId: () => `task_${randomUUID()}`,
    messageId: () => `msg_${randomUUID()}`,
    eventId: () => `evt_${randomUUID()}`,
    scheduleId: () => `sch_${randomUUID()}`,
    executionId: () => `exe_${randomUUID()}`,
    noticeId: () => `ntc_${randomUUID()}`,
    runToken: () => `run_${randomUUID()}`,
    requestId: () => `req_${randomUUID()}`,
    receipt: () => `rcpt_${randomUUID()}`,
    browserSessionId: () => `bs_${randomUUID()}`,
    browserArtifactId: () => `baf_${randomUUID()}`,
  };
}
