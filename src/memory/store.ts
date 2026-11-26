import type { DataMode, MemoryList } from '@coderax/contracts';
import type { MemoryRecord } from '../domain.js';
import type { Clock } from '../support/clock.js';

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
  list: (input: { ownerId: string; mode: DataMode }) => Promise<MemoryList>;
  get: (input: {
    ownerId: string;
    mode: DataMode;
    key: string;
  }) => Promise<MemoryRecord | null>;
};

function partition(ownerId: string, mode: DataMode, key: string): string {
  return JSON.stringify([ownerId, mode, key]);
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
    list: async ({ ownerId, mode }) => ({
      entries: [...entries.values()]
        .filter((entry) => entry.ownerId === ownerId && entry.mode === mode)
        .sort((left, right) => left.key.localeCompare(right.key))
        .map((entry) => ({
          key: entry.key,
          value: entry.value,
          mode: entry.mode,
          updatedAt: entry.updatedAt,
        })),
    }),
    get: async ({ ownerId, mode, key }) => entries.get(partition(ownerId, mode, key)) ?? null,
  };
}
