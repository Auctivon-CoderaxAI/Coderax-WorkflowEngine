import type { ExecutionEvent } from '@coderax/contracts';

/** What the durable log did with an event the bus already ordered. */
export type AppendOutcome =
  | { stored: true }
  | { stored: false; reason: 'duplicate' | 'conflict' };

/**
 * Append-only history for execution events.
 *
 * The bus owns sequencing for a live run; the log keeps what was published so a
 * client can replay it after the process that produced it is gone. `append` is
 * idempotent by `eventId`: the same event written twice is reported as a
 * `duplicate` rather than stored twice, and a different event on an occupied
 * sequence is a `conflict` rather than an overwrite.
 */
export type EventLog = {
  append: (event: ExecutionEvent) => Promise<AppendOutcome>;
  /** Events strictly after `after`, in sequence order. */
  read: (taskId: string, after: number) => Promise<ExecutionEvent[]>;
  lastSeq: (taskId: string) => Promise<number>;
};
