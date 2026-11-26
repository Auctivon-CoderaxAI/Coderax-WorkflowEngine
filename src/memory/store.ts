import type {
  DataMode,
  MemoryList,
  MemoryMatch,
  MemorySearchResult,
} from '@coderax/contracts';
import type { MemoryRecord } from '../domain.js';
import type { Clock } from '../support/clock.js';

/**
 * Memory is partitioned by owner and by data mode.
 *
 * A cloud run cannot read a private entry and a private run cannot read a cloud
 * entry, because the partition is part of the lookup key rather than a filter a
 * caller may forget. Only Coderax Native's isolation includes memory access;
 * external agents receive none.
 *
 * Retrieval is lexical on purpose: it is deterministic, it needs no model call
 * and therefore costs nothing, and it cannot invent a "relevant" entry that the
 * owner never wrote. It is not presented as semantic search.
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
  delete: (input: { ownerId: string; mode: DataMode; key: string }) => Promise<boolean>;
  search: (input: {
    ownerId: string;
    mode: DataMode;
    query: string;
    limit: number;
  }) => Promise<MemorySearchResult>;
};

function partition(ownerId: string, mode: DataMode, key: string): string {
  return JSON.stringify([ownerId, mode, key]);
}

function terms(query: string): string[] {
  return [...new Set(
    query
      .toLowerCase()
      .split(/[^a-z0-9_]+/)
      .filter((term) => term.length > 0),
  )];
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
    delete: async ({ ownerId, mode, key }) => entries.delete(partition(ownerId, mode, key)),
    search: async ({ ownerId, mode, query, limit }) => {
      const wanted = terms(query);
      const matches: MemoryMatch[] = [];
      if (wanted.length > 0) {
        for (const entry of entries.values()) {
          if (entry.ownerId !== ownerId || entry.mode !== mode) continue;
          const keyText = entry.key.toLowerCase();
          const valueText = entry.value.toLowerCase();
          let score = 0;
          for (const term of wanted) {
            // A key hit is a stronger signal than a body hit.
            if (keyText.includes(term)) score += 2;
            else if (valueText.includes(term)) score += 1;
          }
          if (score === 0) continue;
          matches.push({
            key: entry.key,
            value: entry.value,
            mode: entry.mode,
            updatedAt: entry.updatedAt,
            score,
          });
        }
      }
      matches.sort(
        (left, right) => right.score - left.score || right.updatedAt.localeCompare(left.updatedAt),
      );
      return { query, matches: matches.slice(0, limit) };
    },
  };
}
