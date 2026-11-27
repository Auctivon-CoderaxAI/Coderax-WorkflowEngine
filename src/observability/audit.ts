import type { AuditRecord } from '../domain.js';
import type { Clock, IdGenerator } from '../support/clock.js';
import { redactText } from './redact.js';

/**
 * Every accepted, refused and settled task leaves a receipt. The log is
 * append-only and carries no credential, message text or absolute path, so it can
 * be retained and inspected without becoming a second copy of private content.
 */
export type AuditLog = {
  record: (input: Omit<AuditRecord, 'at' | 'receipt'>) => AuditRecord;
  list: (limit?: number) => AuditRecord[];
};

export function createAuditLog(input: { clock: Clock; ids: IdGenerator; limit?: number }): AuditLog {
  const records: AuditRecord[] = [];
  const limit = input.limit ?? 5_000;

  return {
    record: (entry) => {
      const record: AuditRecord = {
        ...entry,
        ...(entry.detail !== undefined ? { detail: redactText(entry.detail, [], 500) } : {}),
        at: input.clock.iso(),
        receipt: input.ids.receipt(),
      };
      records.push(record);
      if (records.length > limit) {
        records.splice(0, records.length - limit);
      }
      return record;
    },
    list: (count) => (count ? records.slice(-count) : [...records]),
  };
}
