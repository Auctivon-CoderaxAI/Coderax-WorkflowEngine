import type { DataMode, MemoryList } from '@coderax/contracts';
import type { MemoryRecord } from '../domain.js';
import type { Clock } from '../support/clock.js';
import { clampLimit } from '../persistence/pagination.js';

/**
 * Memory is partitioned by owner and by data mode.
 *
 * A cloud run cannot read a private entry and a private run cannot read a cloud
 * entry, because the partition is part of the lookup key rather than a filter a
 * caller may forget. Only Coderax Native's isolation includes memory access;
 * external agents receive none.
 */
export type MemoryStore = {
  put: (input: {
    ownerId: string;
    tenantId: string | null;
    mode: DataMode;
    key: string;
    value: string;
  }) => Promise<void>;
  list: (input: {
    ownerId: string;
    mode: DataMode;
    limit?: number;
    cursor?: string;
  }) => Promise<MemoryList>;
  get: (input: {
    ownerId: string;
    mode: DataMode;
    key: string;
  }) => Promise<MemoryRecord | null>;
  delete: (input: { ownerId: string; mode: DataMode; key: string }) => Promise<boolean>;
};

function partition(ownerId: string, mode: DataMode, key: string): string {
  return JSON.stringify([ownerId, mode, key]);
}

function entry(record: MemoryRecord) {
  return {
    key: record.key,
    value: record.value,
    mode: record.mode,
    updatedAt: record.updatedAt,
  };
}

export function createMemoryStore(input: { clock: Clock; maxValueLength: number }): MemoryStore {
  const entries = new Map<string, MemoryRecord>();

  return {
    put: async ({ ownerId, tenantId, mode, key, value }) => {
      if (value.length > input.maxValueLength) {
        throw new Error('memory value exceeds the configured bound');
      }
      entries.set(partition(ownerId, mode, key), {
        ownerId,
        tenantId,
        mode,
        key,
        value,
        updatedAt: input.clock.iso(),
      });
    },
    list: async ({ ownerId, mode, limit, cursor }) => {
      const bounded = clampLimit(limit, 100);
      const owned = [...entries.values()]
        .filter((record) => record.ownerId === ownerId && record.mode === mode)
        .sort((left, right) => left.key.localeCompare(right.key));
      const after = cursor ? owned.filter((record) => record.key > cursor) : owned;
      const page = after.slice(0, bounded);
      const hasMore = after.length > bounded;
      return {
        entries: page.map(entry),
        ...(hasMore && page.length > 0 ? { nextCursor: page[page.length - 1]!.key } : {}),
      };
    },
    get: async ({ ownerId, mode, key }) => entries.get(partition(ownerId, mode, key)) ?? null,
    delete: async ({ ownerId, mode, key }) => entries.delete(partition(ownerId, mode, key)),
  };
}
