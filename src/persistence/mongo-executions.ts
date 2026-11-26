import type { ExecutionRecord } from '../execution/identity.js';
import type { ExecutionRepository, FinishExecutionInput } from './executions.js';
import { isDuplicateKey } from './mongo.js';
import type { MongoCollectionLike } from './mongo.js';

/**
 * Mongo-backed execution identities.
 *
 * The unique `executionId` index is what makes an identity unique across
 * replicas. `finish` filters on a non-terminal phase, so two paths that both
 * believe they ended the attempt cannot both write a cause; the loser reads the
 * record the winner wrote instead of overwriting it.
 */
export async function ensureExecutionIndexes(collection: MongoCollectionLike): Promise<void> {
  await collection.createIndex({ executionId: 1 }, { unique: true, name: 'execution_id' });
  await collection.createIndex(
    { phase: 1, lastHeartbeatAt: 1 },
    { name: 'execution_phase_heartbeat' },
  );
  await collection.createIndex({ taskId: 1, startedAt: 1 }, { name: 'execution_task_started' });
  await collection.createIndex({ phase: 1, finishedAt: 1 }, { name: 'execution_phase_finished' });
}

function toRecord(document: Record<string, unknown>): ExecutionRecord {
  if (typeof document.executionId !== 'string' || typeof document.kind !== 'string') {
    throw new Error('A stored execution row is malformed.');
  }
  const copy = { ...document };
  delete copy._id;
  return copy as unknown as ExecutionRecord;
}

export function createMongoExecutionRepository(
  collection: MongoCollectionLike,
): ExecutionRepository {
  async function finish(input: FinishExecutionInput): Promise<ExecutionRecord | null> {
    const updated = await collection.findOneAndUpdate(
      { executionId: input.executionId, phase: { $ne: 'finished' } },
      {
        $set: {
          phase: 'finished',
          cause: input.cause,
          lastHeartbeatAt: input.finishedAt,
          finishedAt: input.finishedAt,
          termination: input.termination,
          capabilityRevokedAt: input.capabilityRevokedAt,
          processUseCount: input.processUseCount,
        },
      },
      { returnDocument: 'after', includeResultMetadata: false },
    );
    return updated ? toRecord(updated) : null;
  }

  return {
    create: async (record) => {
      try {
        await collection.insertOne({ ...record });
        return true;
      } catch (error) {
        if (isDuplicateKey(error)) return false;
        throw error;
      }
    },

    get: async (executionId) => {
      const document = await collection.findOne({ executionId });
      return document ? toRecord(document) : null;
    },

    heartbeat: async (executionId, at) => {
      const updated = await collection.findOneAndUpdate(
        { executionId, phase: { $ne: 'finished' } },
        { $set: { lastHeartbeatAt: at } },
        { returnDocument: 'after', includeResultMetadata: false },
      );
      return updated !== null;
    },

    finish,

    listActive: async () => {
      const documents = await collection
        .find({ phase: { $ne: 'finished' } })
        .sort({ startedAt: 1 })
        .toArray();
      return documents.map(toRecord);
    },

    listByTask: async (taskId) => {
      const documents = await collection.find({ taskId }).sort({ startedAt: 1 }).toArray();
      return documents.map(toRecord);
    },

    retireStale: async ({ before, at }) => {
      const documents = await collection
        .find({ phase: { $ne: 'finished' }, lastHeartbeatAt: { $lt: before } })
        .toArray();
      let retired = 0;
      for (const document of documents) {
        const record = toRecord(document);
        const applied = await finish({
          executionId: record.executionId,
          cause: 'interrupted',
          finishedAt: at,
          capabilityRevokedAt: at,
          processUseCount: record.processUseCount,
          termination: {
            status: 'unverified',
            reason: 'adapter_did_not_report',
            observedAt: at,
            detail: 'The process that owned this execution stopped heartbeating.',
          },
        });
        if (applied) retired += 1;
      }
      return retired;
    },

    prune: async (before, limit) => {
      if (limit <= 0) return 0;
      const expired = await collection
        .find({ phase: 'finished', finishedAt: { $lt: before } })
        .limit(limit)
        .toArray();
      const ids = expired
        .map((document) => document.executionId)
        .filter((id): id is string => typeof id === 'string');
      if (ids.length === 0) return 0;
      const result = await collection.deleteMany({
        executionId: { $in: ids },
        phase: 'finished',
      });
      return result.deletedCount ?? 0;
    },
  };
}
