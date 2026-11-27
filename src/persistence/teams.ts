import type { TeamPatch, TeamRecord } from '../domain.js';
import type { MongoCollectionLike } from './mongo.js';

/**
 * The durable team snapshot.
 *
 * A team is one document: the plan, every member's state, the completed-member
 * checkpoint, the artifacts the engine hashed and the verification result. A
 * restart reads exactly this, so it can resume at the first unfinished member
 * instead of re-running work that already completed.
 *
 * Writes are fenced by `runToken` + `generation`. A superseded replica cannot
 * overwrite the checkpoint of the generation that replaced it.
 */
export type TeamRepository = {
  create: (record: TeamRecord) => Promise<boolean>;
  get: (ownerId: string, teamId: string) => Promise<TeamRecord | null>;
  /** Claims execution for one generation; null means it is not claimable. */
  claim: (input: {
    teamId: string;
    generation: number;
    token: string;
    at: string;
  }) => Promise<TeamRecord | null>;
  updateFenced: (input: {
    teamId: string;
    token: string;
    generation: number;
    patch: TeamPatch;
  }) => Promise<{ applied: boolean; record: TeamRecord | null }>;
  /** Moves an interrupted/suspended team to a new generation, still unclaimed. */
  resume: (input: {
    teamId: string;
    ownerId: string;
    expectedGeneration: number;
    at: string;
  }) => Promise<TeamRecord | null>;
  heartbeat: (input: { teamId: string; token: string; at: string }) => Promise<boolean>;
  /** Durable and unfenced on purpose: a cancel may land on another replica. */
  requestCancel: (input: { ownerId: string; teamId: string; at: string }) => Promise<boolean>;
  /**
   * Cancels a team that has no live execution loop (queued, suspended or
   * interrupted). The condition is part of the atomic write, so a concurrent
   * claim cannot be cancelled out from under its runner.
   */
  cancelInactive: (input: {
    ownerId: string;
    teamId: string;
    at: string;
  }) => Promise<TeamRecord | null>;
  listByOwner: (ownerId: string) => Promise<TeamRecord[]>;
  listActive: () => Promise<TeamRecord[]>;
  retireStale: (input: { before: string; at: string }) => Promise<number>;
};

function clone(record: TeamRecord): TeamRecord {
  return structuredClone(record);
}

export function createTeamRepository(): TeamRepository {
  const teams = new Map<string, TeamRecord>();

  return {
    create: async (record) => {
      if (teams.has(record.teamId)) return false;
      teams.set(record.teamId, clone(record));
      return true;
    },

    get: async (ownerId, teamId) => {
      const record = teams.get(teamId);
      return record && record.ownerId === ownerId ? clone(record) : null;
    },

    claim: async ({ teamId, generation, token, at }) => {
      const record = teams.get(teamId);
      if (!record || record.generation !== generation || record.runToken !== null) return null;
      record.runToken = token;
      record.state = 'running';
      record.heartbeatAt = at;
      record.updatedAt = at;
      record.startedAt = record.startedAt ?? at;
      return clone(record);
    },

    updateFenced: async ({ teamId, token, generation, patch }) => {
      const record = teams.get(teamId);
      if (!record || record.runToken !== token || record.generation !== generation) {
        return { applied: false, record: record ? clone(record) : null };
      }
      Object.assign(record, patch);
      return { applied: true, record: clone(record) };
    },

    resume: async ({ teamId, ownerId, expectedGeneration, at }) => {
      const record = teams.get(teamId);
      if (!record || record.ownerId !== ownerId) return null;
      if (record.generation !== expectedGeneration || record.runToken !== null) return null;
      if (record.state !== 'interrupted' && record.state !== 'awaiting_approval') return null;
      record.generation += 1;
      record.state = 'queued';
      record.failure = null;
      record.cancelRequested = false;
      record.heartbeatAt = null;
      record.updatedAt = at;
      return clone(record);
    },

    heartbeat: async ({ teamId, token, at }) => {
      const record = teams.get(teamId);
      if (!record || record.runToken !== token) return false;
      record.heartbeatAt = at;
      return true;
    },

    requestCancel: async ({ ownerId, teamId, at }) => {
      const record = teams.get(teamId);
      if (!record || record.ownerId !== ownerId) return false;
      record.cancelRequested = true;
      record.updatedAt = at;
      return true;
    },

    cancelInactive: async ({ ownerId, teamId, at }) => {
      const record = teams.get(teamId);
      if (!record || record.ownerId !== ownerId || record.runToken !== null) return null;
      if (!['queued', 'awaiting_approval', 'interrupted'].includes(record.state)) return null;
      record.state = 'cancelled';
      record.cancelRequested = true;
      record.finishedAt = at;
      record.updatedAt = at;
      record.failure = {
        code: 'cancelled',
        detail: 'The team was cancelled before it acquired an execution.',
        retryable: false,
      };
      return clone(record);
    },

    listByOwner: async (ownerId) =>
      [...teams.values()]
        .filter((record) => record.ownerId === ownerId)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
        .map(clone),

    listActive: async () =>
      [...teams.values()]
        .filter((record) => record.state === 'running' || record.state === 'queued')
        .map(clone),

    retireStale: async ({ before, at }) => {
      let retired = 0;
      for (const record of teams.values()) {
        if (record.state !== 'running' && record.state !== 'queued') continue;
        if (record.heartbeatAt !== null && record.heartbeatAt >= before) continue;
        if (record.state === 'queued') continue;
        record.state = 'interrupted';
        record.runToken = null;
        record.heartbeatAt = at;
        record.updatedAt = at;
        record.failure = {
          code: 'server_unavailable',
          detail: 'The team stopped heartbeating and was retired as interrupted.',
          retryable: true,
        };
        retired += 1;
      }
      return retired;
    },
  };
}

function fromDocument(document: Record<string, unknown>): TeamRecord {
  const { _id, ...record } = document;
  return clone(record as unknown as TeamRecord);
}

export function createMongoTeamRepository(input: {
  collection: MongoCollectionLike;
}): TeamRepository {
  const collection = input.collection;

  return {
    create: async (record) => {
      try {
        await collection.insertOne({ ...record, _id: record.teamId });
        return true;
      } catch {
        return false;
      }
    },

    get: async (ownerId, teamId) => {
      const document = await collection.findOne({ teamId, ownerId });
      return document ? fromDocument(document) : null;
    },

    claim: async ({ teamId, generation, token, at }) => {
      // `runToken: null` makes the claim a compare-and-swap: a second replica
      // resuming the same generation matches nothing.
      const document = await collection.findOneAndUpdate(
        { teamId, generation, runToken: null },
        {
          $set: {
            runToken: token,
            state: 'running',
            heartbeatAt: at,
            updatedAt: at,
          },
        },
        { returnDocument: 'after', includeResultMetadata: false },
      );
      return document ? fromDocument(document) : null;
    },

    updateFenced: async ({ teamId, token, generation, patch }) => {
      const document = await collection.findOneAndUpdate(
        { teamId, runToken: token, generation },
        { $set: patch as Record<string, unknown> },
        { returnDocument: 'after', includeResultMetadata: false },
      );
      if (document) return { applied: true, record: fromDocument(document) };
      const current = await collection.findOne({ teamId });
      return { applied: false, record: current ? fromDocument(current) : null };
    },

    resume: async ({ teamId, ownerId, expectedGeneration, at }) => {
      // `runToken: null` plus the generation is the compare-and-swap. A running
      // team has a token, so it can never be resumed concurrently.
      const document = await collection.findOneAndUpdate(
        {
          teamId,
          ownerId,
          generation: expectedGeneration,
          runToken: null,
          // A concurrent `cancelInactive` leaves the generation and token
          // unchanged, so the allowed states are part of the compare-and-swap.
          state: { $in: ['interrupted', 'awaiting_approval'] },
        },
        {
          $set: {
            generation: expectedGeneration + 1,
            state: 'queued',
            failure: null,
            cancelRequested: false,
            heartbeatAt: null,
            updatedAt: at,
          },
        },
        { returnDocument: 'after', includeResultMetadata: false },
      );
      return document ? fromDocument(document) : null;
    },

    heartbeat: async ({ teamId, token, at }) => {
      const result = await collection.updateOne(
        { teamId, runToken: token },
        { $set: { heartbeatAt: at } },
        { upsert: false },
      );
      return (result.matchedCount ?? 0) === 1;
    },

    requestCancel: async ({ ownerId, teamId, at }) => {
      const result = await collection.updateOne(
        { teamId, ownerId },
        { $set: { cancelRequested: true, updatedAt: at } },
        { upsert: false },
      );
      return (result.matchedCount ?? 0) === 1;
    },

    cancelInactive: async ({ ownerId, teamId, at }) => {
      const document = await collection.findOneAndUpdate(
        {
          teamId,
          ownerId,
          runToken: null,
          state: { $in: ['queued', 'awaiting_approval', 'interrupted'] },
        },
        {
          $set: {
            state: 'cancelled',
            cancelRequested: true,
            finishedAt: at,
            updatedAt: at,
            failure: {
              code: 'cancelled',
              detail: 'The team was cancelled before it acquired an execution.',
              retryable: false,
            },
          },
        },
        { returnDocument: 'after', includeResultMetadata: false },
      );
      return document ? fromDocument(document) : null;
    },

    listByOwner: async (ownerId) => {
      const documents = await collection.find({ ownerId }).sort({ createdAt: -1 }).toArray();
      return documents.map(fromDocument);
    },

    listActive: async () => {
      const running = await collection.find({ state: 'running' }).toArray();
      const queued = await collection.find({ state: 'queued' }).toArray();
      return [...running, ...queued].map(fromDocument);
    },

    retireStale: async ({ before, at }) => {
      const stale = await collection.find({ state: 'running' }).toArray();
      let retired = 0;
      for (const document of stale) {
        const heartbeat = document.heartbeatAt;
        if (typeof heartbeat === 'string' && heartbeat >= before) continue;
        const result = await collection.updateOne(
          { teamId: document.teamId, state: 'running', heartbeatAt: heartbeat ?? null },
          {
            $set: {
              state: 'interrupted',
              runToken: null,
              heartbeatAt: at,
              updatedAt: at,
              failure: {
                code: 'server_unavailable',
                detail: 'The team stopped heartbeating and was retired as interrupted.',
                retryable: true,
              },
            },
          },
          { upsert: false },
        );
        if ((result.matchedCount ?? 0) === 1) retired += 1;
      }
      return retired;
    },
  };
}

export async function ensureTeamIndexes(input: { collection: MongoCollectionLike }): Promise<void> {
  await input.collection.createIndex({ teamId: 1 }, { unique: true, name: 'team_id' });
  await input.collection.createIndex({ ownerId: 1, createdAt: -1 }, { name: 'team_owner' });
  await input.collection.createIndex({ state: 1 }, { name: 'team_state' });
}
