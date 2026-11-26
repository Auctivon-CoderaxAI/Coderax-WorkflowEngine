import { TERMINAL_TASK_STATES, isTerminalState } from '@coderax/contracts';
import type {
  ConversationRecord,
  MemoryRecord,
  NotificationRecord,
  StoredMessage,
  TaskRecord,
} from '../domain.js';
import type { ConversationRepository } from './conversations.js';
import { toConversationSummary } from './conversations.js';
import type { NotificationPageInput, NotificationStore } from './notifications.js';
import type {
  CreateTaskResult,
  FencedWriteResult,
  TaskPageInput,
  TaskRepository,
  TaskStateCounts,
} from './tasks.js';
import { STATES, taskIdempotencyKey } from './tasks.js';
import { clampLimit, decodeCursor, encodeCursor } from './pagination.js';
import type { MemoryStore } from '../memory/store.js';
import type { Clock } from '../support/clock.js';
import { isAuthorizedGeneration } from '../execution/lease.js';
import { isDuplicateKey } from './mongo.js';
import type { MongoCollectionLike } from './mongo.js';

/**
 * Durable task, conversation, memory and notification stores.
 *
 * Each store maps one contract method onto one database operation, so the
 * semantics are the same as the in-memory implementation while the durability is
 * not. The one place where that is more than a translation is `updateFenced`:
 * the fencing token and the terminal check are part of the update filter, so a
 * superseded generation matches nothing instead of reading and then racing a
 * newer writer.
 */

const TERMINAL = [...TERMINAL_TASK_STATES];

function strip(document: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...document };
  delete copy._id;
  return copy;
}

function defined(patch: object): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(patch as Record<string, unknown>).filter(([, value]) => value !== undefined),
  );
}

function toTask(document: Record<string, unknown>): TaskRecord {
  if (
    typeof document.taskId !== 'string' ||
    typeof document.ownerId !== 'string' ||
    typeof document.conversationId !== 'string' ||
    typeof document.state !== 'string'
  ) {
    throw new Error('A stored task row is malformed.');
  }
  return strip(document) as unknown as TaskRecord;
}

function toConversation(document: Record<string, unknown>): ConversationRecord {
  if (
    typeof document.conversationId !== 'string' ||
    typeof document.ownerId !== 'string' ||
    typeof document.mode !== 'string' ||
    typeof document.agent !== 'string'
  ) {
    throw new Error('A stored conversation row is malformed.');
  }
  return strip(document) as unknown as ConversationRecord;
}

function toMessage(document: Record<string, unknown>): StoredMessage {
  if (
    typeof document.messageId !== 'string' ||
    typeof document.conversationId !== 'string' ||
    typeof document.text !== 'string' ||
    (document.role !== 'user' && document.role !== 'assistant' && document.role !== 'tool')
  ) {
    throw new Error('A stored message row is malformed.');
  }
  return strip(document) as unknown as StoredMessage;
}

function toMemory(document: Record<string, unknown>): MemoryRecord {
  if (
    typeof document.key !== 'string' ||
    typeof document.ownerId !== 'string' ||
    typeof document.value !== 'string'
  ) {
    throw new Error('A stored memory row is malformed.');
  }
  return strip(document) as unknown as MemoryRecord;
}

function toNotification(document: Record<string, unknown>): NotificationRecord {
  if (
    typeof document.taskId !== 'string' ||
    typeof document.ownerId !== 'string' ||
    typeof document.state !== 'string'
  ) {
    throw new Error('A stored notification row is malformed.');
  }
  return strip(document) as unknown as NotificationRecord;
}

export async function ensureIdempotencyIndexes(collection: MongoCollectionLike): Promise<void> {
  await collection.createIndex({ key: 1 }, { unique: true, name: 'idempotency_key' });
  await collection.createIndex({ createdAt: 1 }, { name: 'idempotency_created' });
}

export async function ensureTaskIndexes(collection: MongoCollectionLike): Promise<void> {
  await collection.createIndex({ taskId: 1 }, { unique: true, name: 'task_id' });
  await collection.createIndex(
    { conversationId: 1, state: 1 },
    { name: 'task_conversation_state' },
  );
  await collection.createIndex({ ownerId: 1 }, { name: 'task_owner' });
  await collection.createIndex(
    { ownerId: 1, updatedAt: -1, taskId: -1 },
    { name: 'task_owner_updated' },
  );
  await collection.createIndex({ state: 1 }, { name: 'task_state' });
  await collection.createIndex(
    { conversationId: 1, updatedAt: -1, taskId: -1 },
    { name: 'task_conversation_updated' },
  );
}

export async function ensureConversationIndexes(input: {
  conversations: MongoCollectionLike;
  messages: MongoCollectionLike;
}): Promise<void> {
  await input.conversations.createIndex(
    { conversationId: 1 },
    { unique: true, name: 'conversation_id' },
  );
  await input.conversations.createIndex(
    { ownerId: 1, updatedAt: -1, conversationId: -1 },
    { name: 'conversation_owner_updated' },
  );
  await input.conversations.createIndex(
    { ownerId: 1, mode: 1, isWork: 1, updatedAt: -1 },
    { name: 'conversation_owner_filters' },
  );
  await input.messages.createIndex({ messageId: 1 }, { unique: true, name: 'message_id' });
  await input.messages.createIndex(
    { conversationId: 1, createdAt: 1 },
    { name: 'message_conversation_created' },
  );
}

export async function ensureMemoryIndexes(collection: MongoCollectionLike): Promise<void> {
  await collection.createIndex(
    { ownerId: 1, mode: 1, key: 1 },
    { unique: true, name: 'memory_partition' },
  );
}

export async function ensureNotificationIndexes(collection: MongoCollectionLike): Promise<void> {
  await collection.createIndex({ taskId: 1 }, { unique: true, name: 'notification_task' });
  await collection.createIndex(
    { ownerId: 1, createdAt: -1, taskId: -1 },
    { name: 'notification_owner_created' },
  );
  await collection.createIndex(
    { ownerId: 1, read: 1 },
    { name: 'notification_owner_read' },
  );
  await collection.createIndex({ createdAt: 1 }, { name: 'notification_created' });
}

const REPLAY_ATTEMPTS = 20;
const REPLAY_DELAY_MS = 10;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}

export function createMongoTaskRepository(
  collection: MongoCollectionLike,
  idempotency?: MongoCollectionLike,
): TaskRepository {
  async function taskById(taskId: unknown): Promise<TaskRecord | null> {
    if (typeof taskId !== 'string') return null;
    const document = await collection.findOne({ taskId });
    return document ? toTask(document) : null;
  }

  /**
   * The reservation is written before the task, so a concurrent duplicate can
   * wait for the winner's task instead of creating a second one.
   */
  async function waitForReplay(key: string): Promise<TaskRecord | null> {
    if (!idempotency) return null;
    const row = await idempotency.findOne({ key });
    if (!row) return null;
    for (let attempt = 0; attempt < REPLAY_ATTEMPTS; attempt += 1) {
      const task = await taskById(row.taskId);
      if (task) return task;
      await delay(REPLAY_DELAY_MS);
    }
    return null;
  }

  return {
    create: async (task, options): Promise<CreateTaskResult> => {
      // The lease already arbitrates one live run per conversation; this check
      // preserves the repository's own refusal for callers that skip the lease.
      const live = await collection.findOne({
        conversationId: task.conversationId,
        state: { $nin: TERMINAL },
      });
      if (live && live.taskId !== task.taskId) {
        return { ok: false, reason: 'conversation_busy' };
      }

      let reservation: string | null = null;
      if (options?.idempotencyKey) {
        if (!idempotency) {
          throw new Error('idempotency storage is not configured');
        }
        reservation = taskIdempotencyKey(task.ownerId, options.idempotencyKey);
        try {
          await idempotency.insertOne({
            key: reservation,
            taskId: task.taskId,
            createdAt: new Date().toISOString(),
          });
        } catch (error) {
          if (!isDuplicateKey(error)) throw error;
          const existing = await waitForReplay(reservation);
          if (existing) return { ok: false, reason: 'idempotent', task: existing };
          return { ok: false, reason: 'exists' };
        }
      }

      try {
        await collection.insertOne({ ...task });
        return { ok: true, task };
      } catch (error) {
        if (reservation && idempotency) {
          await idempotency.deleteOne({ key: reservation }).catch(() => undefined);
        }
        if (isDuplicateKey(error)) return { ok: false, reason: 'exists' };
        throw error;
      }
    },

    get: async (taskId) => {
      const document = await collection.findOne({ taskId });
      return document ? toTask(document) : null;
    },

    findByIdempotencyKey: async (ownerId, key) => {
      if (!idempotency) return null;
      const row = await idempotency.findOne({ key: taskIdempotencyKey(ownerId, key) });
      return row ? taskById(row.taskId) : null;
    },

    updateFenced: async ({ taskId, token, patch }): Promise<FencedWriteResult> => {
      const updated = await collection.findOneAndUpdate(
        { taskId, runToken: token, state: { $nin: TERMINAL } },
        { $set: { ...defined(patch), runToken: token } },
        { returnDocument: 'after', includeResultMetadata: false },
      );
      if (updated) return { applied: true, task: toTask(updated) };

      const current = await collection.findOne({ taskId });
      if (!current) return { applied: false, reason: 'not_found' };
      const task = toTask(current);
      if (!isAuthorizedGeneration(task.runToken, token)) {
        return { applied: false, reason: 'superseded' };
      }
      return { applied: false, reason: 'terminal' };
    },

    abandon: async ({ taskId, patch }) => {
      const updated = await collection.findOneAndUpdate(
        { taskId, runToken: null },
        { $set: defined(patch) },
        { returnDocument: 'after', includeResultMetadata: false },
      );
      return updated !== null;
    },

    reissue: async ({ taskId, token, now, leaseExpiresAt }): Promise<FencedWriteResult> => {
      const current = await collection.findOne({ taskId });
      if (!current) return { applied: false, reason: 'not_found' };
      const task = toTask(current);
      if (!isTerminalState(task.state) && task.state !== 'awaiting_approval') {
        return { applied: false, reason: 'superseded' };
      }
      // Generation and state are part of the filter: two replicas resuming the
      // same task cannot both issue a new generation.
      const updated = await collection.findOneAndUpdate(
        { taskId, generation: task.generation, state: task.state, runToken: task.runToken },
        {
          $set: {
            state: 'queued',
            generation: task.generation + 1,
            checkpoint: { ...task.checkpoint, text: '' },
            runToken: token,
            updatedAt: now,
            leaseExpiresAt,
            cancelRequested: false,
            failure: null,
            result: null,
          },
        },
        { returnDocument: 'after', includeResultMetadata: false },
      );
      if (!updated) return { applied: false, reason: 'superseded' };
      return { applied: true, task: toTask(updated) };
    },

    listByConversation: async (conversationId) => {
      const documents = await collection
        .find({ conversationId })
        .sort({ createdAt: 1 })
        .toArray();
      return documents.map(toTask);
    },

    listUnsettled: async () => {
      const documents = await collection.find({ state: { $nin: TERMINAL } }).toArray();
      return documents.map(toTask);
    },

    listByOwner: async (ownerId) => {
      const documents = await collection.find({ ownerId }).toArray();
      return documents.map(toTask);
    },

    listPage: async (input: TaskPageInput) => {
      const limit = clampLimit(input.limit);
      const cursor = input.cursor ? decodeCursor(input.cursor) : null;
      const base = {
        ownerId: input.ownerId,
        ...(input.state ? { state: input.state } : {}),
        ...(input.conversationId ? { conversationId: input.conversationId } : {}),
        ...(input.agent ? { agent: input.agent } : {}),
        ...(input.mode ? { mode: input.mode } : {}),
      };
      const filter = {
        ...base,
        ...(cursor
          ? {
              $or: [
                { updatedAt: { $lt: cursor.at } },
                { updatedAt: cursor.at, taskId: { $lt: cursor.id } },
              ],
            }
          : {}),
      };
      const [documents, total] = await Promise.all([
        collection.find(filter).sort({ updatedAt: -1, taskId: -1 }).limit(limit + 1).toArray(),
        collection.countDocuments(base),
      ]);
      const page = documents.slice(0, limit).map(toTask);
      const hasMore = documents.length > limit;
      return {
        tasks: page,
        total,
        ...(hasMore && page.length > 0
          ? { nextCursor: encodeCursor(page[page.length - 1]!.updatedAt, page[page.length - 1]!.taskId) }
          : {}),
      };
    },

    countByState: async () => {
      const counts = Object.fromEntries(STATES.map((state) => [state, 0])) as TaskStateCounts;
      await Promise.all(
        STATES.map(async (state) => {
          counts[state] = await collection.countDocuments({ state });
        }),
      );
      return counts;
    },

    deleteByConversation: async (ownerId, conversationId) => {
      const result = await collection.deleteMany({ ownerId, conversationId });
      return result.deletedCount;
    },
  };
}

export function createMongoConversationRepository(input: {
  conversations: MongoCollectionLike;
  messages: MongoCollectionLike;
}): ConversationRepository {
  const { conversations, messages } = input;

  function collision(): never {
    throw new Error('conversation identity collision across owners');
  }

  async function ensure(record: ConversationRecord): Promise<ConversationRecord> {
    const existing = await conversations.findOne({ conversationId: record.conversationId });
    if (existing) {
      const found = toConversation(existing);
      if (found.ownerId !== record.ownerId) collision();
      return found;
    }
    try {
      await conversations.insertOne({ ...record });
      return { ...record };
    } catch (error) {
      if (!isDuplicateKey(error)) throw error;
      // Another replica created it between the read and the insert.
      const raced = await conversations.findOne({ conversationId: record.conversationId });
      if (!raced) throw error;
      const found = toConversation(raced);
      if (found.ownerId !== record.ownerId) collision();
      return found;
    }
  }

  return {
    ensure,

    get: async (ownerId, conversationId) => {
      const document = await conversations.findOne({ conversationId, ownerId });
      return document ? toConversation(document) : null;
    },

    list: async (ownerId) => {
      const documents = await conversations.find({ ownerId }).sort({ updatedAt: -1 }).toArray();
      return {
        conversations: documents.map(toConversation).map(toConversationSummary),
        total: documents.length,
      };
    },

    listPage: async (input) => {
      const limit = clampLimit(input.limit);
      const cursor = input.cursor ? decodeCursor(input.cursor) : null;
      const base = {
        ownerId: input.ownerId,
        ...(input.mode ? { mode: input.mode } : {}),
        ...(input.isWork === undefined ? {} : { isWork: input.isWork }),
        ...(input.agent ? { agent: input.agent } : {}),
      };
      const filter = {
        ...base,
        ...(cursor
          ? {
              $or: [
                { updatedAt: { $lt: cursor.at } },
                { updatedAt: cursor.at, conversationId: { $lt: cursor.id } },
              ],
            }
          : {}),
      };
      const [documents, total] = await Promise.all([
        conversations
          .find(filter)
          .sort({ updatedAt: -1, conversationId: -1 })
          .limit(limit + 1)
          .toArray(),
        conversations.countDocuments(base),
      ]);
      const page = documents.slice(0, limit).map(toConversation).map(toConversationSummary);
      const hasMore = documents.length > limit;
      return {
        conversations: page,
        total,
        ...(hasMore && page.length > 0
          ? {
              nextCursor: encodeCursor(
                page[page.length - 1]!.updatedAt,
                page[page.length - 1]!.conversationId,
              ),
            }
          : {}),
      };
    },

    appendMessage: async (message) => {
      const existing = await conversations.findOne({ conversationId: message.conversationId });
      if (!existing) return false;
      try {
        await messages.insertOne({ ...message });
      } catch (error) {
        if (isDuplicateKey(error)) return false;
        throw error;
      }
      await conversations.updateOne(
        { conversationId: message.conversationId },
        { $set: { updatedAt: message.createdAt } },
        { upsert: false },
      );
      return true;
    },

    messages: async (conversationId) => {
      const documents = await messages
        .find({ conversationId })
        .sort({ createdAt: 1 })
        .toArray();
      return documents.map(toMessage);
    },

    toContract: async (record) => {
      const stored = await messages
        .find({ conversationId: record.conversationId })
        .sort({ createdAt: 1 })
        .toArray();
      return {
        conversationId: record.conversationId,
        ...(record.title ? { title: record.title } : {}),
        mode: record.mode,
        isWork: record.isWork,
        agent: record.agent,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        messages: stored.map(toMessage).map((message) => ({
          messageId: message.messageId,
          conversationId: message.conversationId,
          role: message.role,
          text: message.text,
          createdAt: message.createdAt,
          ...(message.unfinished !== undefined ? { unfinished: message.unfinished } : {}),
          ...(message.agent ? { agent: message.agent } : {}),
        })),
      };
    },

    updateAgent: async (conversationId, agent) => {
      await conversations.updateOne({ conversationId }, { $set: { agent } }, { upsert: false });
    },

    delete: async (ownerId, conversationId) => {
      const removed = await conversations.deleteOne({ ownerId, conversationId });
      if (removed.deletedCount !== 1) return { deleted: false, messages: 0 };
      const messagesRemoved = await messages.deleteMany({ conversationId });
      return { deleted: true, messages: messagesRemoved.deletedCount };
    },
  };
}

export function createMongoMemoryStore(input: {
  collection: MongoCollectionLike;
  clock: Clock;
  maxValueLength: number;
}): MemoryStore {
  return {
    put: async ({ ownerId, tenantId, mode, key, value }) => {
      if (value.length > input.maxValueLength) {
        throw new Error('memory value exceeds the configured bound');
      }
      await input.collection.updateOne(
        { ownerId, mode, key },
        {
          $set: { tenantId, value, updatedAt: input.clock.iso() },
          $setOnInsert: { ownerId, mode, key },
        },
        { upsert: true },
      );
    },

    list: async ({ ownerId, mode, limit, cursor }) => {
      const bounded = clampLimit(limit, 100);
      const documents = await input.collection
        .find({
          ownerId,
          mode,
          ...(cursor ? { key: { $gt: cursor } } : {}),
        })
        .sort({ key: 1 })
        .limit(bounded + 1)
        .toArray();
      const page = documents.slice(0, bounded).map(toMemory);
      const hasMore = documents.length > bounded;
      return {
        entries: page.map((entry) => ({
          key: entry.key,
          value: entry.value,
          mode: entry.mode,
          updatedAt: entry.updatedAt,
        })),
        ...(hasMore && page.length > 0
          ? { nextCursor: page[page.length - 1]!.key }
          : {}),
      };
    },

    get: async ({ ownerId, mode, key }) => {
      const document = await input.collection.findOne({ ownerId, mode, key });
      return document ? toMemory(document) : null;
    },

    delete: async ({ ownerId, mode, key }) => {
      const result = await input.collection.deleteOne({ ownerId, mode, key });
      return result.deletedCount === 1;
    },
  };
}

export function createMongoNotificationStore(collection: MongoCollectionLike): NotificationStore {
  function contract(entry: NotificationRecord): {
    taskId: string;
    conversationId: string;
    agent: NotificationRecord['agent'];
    mode: NotificationRecord['mode'];
    state: NotificationRecord['state'];
    summary?: string;
    createdAt: string;
    read: boolean;
  } {
    return {
      taskId: entry.taskId,
      conversationId: entry.conversationId,
      agent: entry.agent,
      mode: entry.mode,
      state: entry.state,
      ...(entry.summary ? { summary: entry.summary } : {}),
      createdAt: entry.createdAt,
      read: entry.read,
    };
  }

  return {
    record: async (notification) => {
      await collection.updateOne(
        { taskId: notification.taskId },
        { $set: { ...notification } },
        { upsert: true },
      );
    },

    list: async (input) => {
      const query: NotificationPageInput =
        typeof input === 'string' ? { ownerId: input } : input;
      const limit = clampLimit(query.limit);
      const cursor = query.cursor ? decodeCursor(query.cursor) : null;
      const base = {
        ownerId: query.ownerId,
        ...(query.unreadOnly ? { read: false } : {}),
      };
      const filter = {
        ...base,
        ...(cursor
          ? {
              $or: [
                { createdAt: { $lt: cursor.at } },
                { createdAt: cursor.at, taskId: { $lt: cursor.id } },
              ],
            }
          : {}),
      };
      const [documents, total, unread] = await Promise.all([
        collection
          .find(filter)
          .sort({ createdAt: -1, taskId: -1 })
          .limit(limit + 1)
          .toArray(),
        collection.countDocuments(base),
        collection.countDocuments({ ownerId: query.ownerId, read: false }),
      ]);
      const page = documents.slice(0, limit).map(toNotification);
      const hasMore = documents.length > limit;
      return {
        notifications: page.map(contract),
        unread,
        total,
        ...(hasMore && page.length > 0
          ? {
              nextCursor: encodeCursor(
                page[page.length - 1]!.createdAt,
                page[page.length - 1]!.taskId,
              ),
            }
          : {}),
      };
    },

    markRead: async (ownerId, taskIds) => {
      const unique = [...new Set(taskIds)];
      if (unique.length === 0) return 0;
      const result = await collection.updateMany(
        { ownerId, taskId: { $in: unique }, read: false },
        { $set: { read: true } },
      );
      return result.modifiedCount ?? 0;
    },

    deleteByConversation: async (ownerId, conversationId) => {
      const result = await collection.deleteMany({ ownerId, conversationId });
      return result.deletedCount;
    },

    prune: async (before, limit) => {
      if (limit <= 0) return 0;
      const expired = await collection
        .find({ createdAt: { $lte: before } })
        .limit(limit)
        .toArray();
      const taskIds = expired
        .map((document) => document.taskId)
        .filter((taskId): taskId is string => typeof taskId === 'string');
      if (taskIds.length === 0) return 0;
      const result = await collection.deleteMany({ taskId: { $in: taskIds } });
      return result.deletedCount;
    },
  };
}
