import type { ConversationRecord, StoredMessage } from '../domain.js';
import type { Conversation, ConversationList, Message } from '@coderax/contracts';
import type { AgentId, DataMode } from '@coderax/contracts';

export type ConversationRepository = {
  ensure: (record: ConversationRecord) => Promise<ConversationRecord>;
  get: (ownerId: string, conversationId: string) => Promise<ConversationRecord | null>;
  list: (ownerId: string) => Promise<ConversationList>;
  appendMessage: (message: StoredMessage) => Promise<boolean>;
  messages: (conversationId: string) => Promise<StoredMessage[]>;
  /** Projected into the wire contract; the only place a message shape is chosen. */
  toContract: (record: ConversationRecord) => Promise<Conversation>;
  updateAgent: (conversationId: string, agent: AgentId) => Promise<void>;
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
    ...(message.attachments ? { attachments: message.attachments } : {}),
  };
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
        return existing;
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
    list: async (ownerId) => ({
      conversations: [...conversations.values()]
        .filter((record) => record.ownerId === ownerId)
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .map((record) => ({
          conversationId: record.conversationId,
          ...(record.title ? { title: record.title } : {}),
          isWork: record.isWork,
          agent: record.agent,
          updatedAt: record.updatedAt,
        })),
    }),
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
  };
}
