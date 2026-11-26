import type { ConversationRecord, StoredMessage } from '../domain.js';
import type {
  AgentId,
  Conversation,
  ConversationList,
  ConversationSummary,
  DataMode,
  Message,
} from '@coderax/contracts';
import { clampLimit, decodeCursor, encodeCursor } from './pagination.js';

export type ConversationPageInput = {
  ownerId: string;
  limit?: number;
  cursor?: string;
  mode?: DataMode;
  isWork?: boolean;
  agent?: AgentId;
};

export type ConversationPage = ConversationList & {
  total: number;
  nextCursor?: string;
};

export type ConversationDeletion = {
  deleted: boolean;
  messages: number;
};

export type ConversationRepository = {
  ensure: (record: ConversationRecord) => Promise<ConversationRecord>;
  get: (ownerId: string, conversationId: string) => Promise<ConversationRecord | null>;
  /** Unbounded only for internal callers; HTTP listing uses `listPage`. */
  list: (ownerId: string) => Promise<ConversationList>;
  /** Newest first, bounded, with an opaque cursor. */
  listPage: (input: ConversationPageInput) => Promise<ConversationPage>;
  appendMessage: (message: StoredMessage) => Promise<boolean>;
  messages: (conversationId: string) => Promise<StoredMessage[]>;
  /** Projected into the wire contract; the only place a message shape is chosen. */
  toContract: (record: ConversationRecord) => Promise<Conversation>;
  updateAgent: (conversationId: string, agent: AgentId) => Promise<void>;
  /** Owner-scoped authorized deletion of the conversation and its messages. */
  delete: (ownerId: string, conversationId: string) => Promise<ConversationDeletion>;
};

function toMessage(message: StoredMessage): Message {
  return {
    messageId: message.messageId,
    conversationId: message.conversationId,
    role: message.role,
    text: message.text,
    createdAt: message.createdAt,
    ...(message.unfinished !== undefined ? { unfinished: message.unfinished } : {}),
    ...(message.agent ? { agent: message.agent } : {}),
  };
}

export function toConversationSummary(record: ConversationRecord): ConversationSummary {
  return {
    conversationId: record.conversationId,
    ...(record.title ? { title: record.title } : {}),
    isWork: record.isWork,
    agent: record.agent,
    mode: record.mode,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function matches(record: ConversationRecord, input: ConversationPageInput): boolean {
  return (
    record.ownerId === input.ownerId &&
    (input.mode === undefined || record.mode === input.mode) &&
    (input.isWork === undefined || record.isWork === input.isWork) &&
    (input.agent === undefined || record.agent === input.agent)
  );
}

export function createConversationRepository(): ConversationRepository {
  const conversations = new Map<string, ConversationRecord>();
  const messages = new Map<string, StoredMessage[]>();

  return {
    ensure: async (record) => {
      const existing = conversations.get(record.conversationId);
      if (existing) {
        if (existing.ownerId !== record.ownerId) {
          throw new Error('conversation identity collision across owners');
        }
        return { ...existing };
      }
      conversations.set(record.conversationId, { ...record });
      messages.set(record.conversationId, []);
      return { ...record };
    },
    get: async (ownerId, conversationId) => {
      const record = conversations.get(conversationId);
      if (!record || record.ownerId !== ownerId) return null;
      return { ...record };
    },
    list: async (ownerId) => {
      const owned = [...conversations.values()]
        .filter((record) => record.ownerId === ownerId)
        .sort(
          (left, right) =>
            right.updatedAt.localeCompare(left.updatedAt) ||
            right.conversationId.localeCompare(left.conversationId),
        );
      return { conversations: owned.map(toConversationSummary), total: owned.length };
    },
    listPage: async (input) => {
      const limit = clampLimit(input.limit);
      const cursor = input.cursor ? decodeCursor(input.cursor) : null;
      const matching = [...conversations.values()]
        .filter((record) => matches(record, input))
        .sort(
          (left, right) =>
            right.updatedAt.localeCompare(left.updatedAt) ||
            right.conversationId.localeCompare(left.conversationId),
        );
      const after = cursor
        ? matching.filter(
            (record) =>
              record.updatedAt < cursor.at ||
              (record.updatedAt === cursor.at && record.conversationId < cursor.id),
          )
        : matching;
      const page = after.slice(0, limit);
      const hasMore = after.length > limit;
      return {
        conversations: page.map(toConversationSummary),
        total: matching.length,
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
      const existing = conversations.get(message.conversationId);
      if (!existing) return false;
      const list = messages.get(message.conversationId) ?? [];
      if (list.some((entry) => entry.messageId === message.messageId)) {
        return false;
      }
      list.push({ ...message });
      messages.set(message.conversationId, list);
      existing.updatedAt = message.createdAt;
      return true;
    },
    messages: async (conversationId) => [...(messages.get(conversationId) ?? [])],
    toContract: async (record) => ({
      conversationId: record.conversationId,
      ...(record.title ? { title: record.title } : {}),
      mode: record.mode as DataMode,
      isWork: record.isWork,
      agent: record.agent,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      messages: (messages.get(record.conversationId) ?? []).map(toMessage),
    }),
    updateAgent: async (conversationId, agent) => {
      const record = conversations.get(conversationId);
      if (record) record.agent = agent;
    },
    delete: async (ownerId, conversationId) => {
      const record = conversations.get(conversationId);
      if (!record || record.ownerId !== ownerId) {
        return { deleted: false, messages: 0 };
      }
      conversations.delete(conversationId);
      const removed = messages.get(conversationId)?.length ?? 0;
      messages.delete(conversationId);
      return { deleted: true, messages: removed };
    },
  };
}

