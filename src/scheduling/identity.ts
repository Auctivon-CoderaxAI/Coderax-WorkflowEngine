import { createHash } from 'node:crypto';

/**
 * Deterministic identities for a scheduled occurrence.
 *
 * The task id is the durable idempotency key of the whole scheduling system. Two
 * replicas that recover the same occurrence compute the same id, and the task
 * repository's unique `taskId` index lets exactly one of them create it. A retry
 * uses a different attempt number, so a new generation is possible without ever
 * colliding with the attempt it replaces.
 */

function digest(value: string, length: number): string {
  return createHash('sha256').update(value).digest('hex').slice(0, length);
}

export function scheduledConversationId(scheduleId: string): string {
  return `conv_sched_${digest(scheduleId, 32)}`;
}

export function scheduledTaskId(
  scheduleId: string,
  occurrenceKey: string,
  attempt: number,
): string {
  return `task_sched_${digest(`${scheduleId}\u0000${occurrenceKey}\u0000${attempt}`, 40)}`;
}
