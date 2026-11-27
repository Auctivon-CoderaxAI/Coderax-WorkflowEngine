import type { ConversationRecord, StoredMessage } from '../domain.js';
import type { Conversation, ConversationList, Message } from '@coderax/contracts';
import type { AgentId, DataMode } from '@coderax/contracts';
import { redactContent } from '../observability/redact.js';

export type ConversationBinding =
  | { ok: true; record: ConversationRecord }
  | { ok: false; reason: 'owner' | 'mode' | 'surface' };

/**
 * A conversation carries an owner, a data mode and a kind of work.
 *
 * Reusing an identifier across any of them would move a private transcript into a
 * cloud run (or a Work transcript into a chat), so `ensure` refuses the collision
 * instead of returning the existing row. The caller maps the reason onto a stable
 * problem; the repository is the authority.
 */
export type ConversationConflictReason = 'owner' | 'mode' | 'kind';

export class ConversationConflictError extends Error {
  readonly reason: ConversationConflictReason;

  constructor(reason: ConversationConflictReason) {
    super('conversation identity conflict');
    this.name = 'ConversationConflictError';
    this.reason = reason;
  }
}

export type ConversationRepository = {
  /** Reuse an ID only when the stored owner and data mode both match. */
  ensure: (record: ConversationRecord) => Promise<ConversationRecord>;
  get: (ownerId: string, conversationId: string) => Promise<ConversationRecord | null>;
  list: (ownerId: string) => Promise<ConversationList>;
  appendMessage: (message: StoredMessage) => Promise<boolean>;
  /** Owner- and mode-scoped. Null means the conversation is not readable here. */
  messages: (input: {
    ownerId: string;
    conversationId: string;
    mode: DataMode;
  }) => Promise<StoredMessage[] | null>;
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
    ...(message.media && message.media.length > 0 ? { media: message.media } : {}),
  };
}

export function createConversationRepository(): ConversationRepository {
  const conversations = new Map<string, ConversationRecord>();
  const messages = new Map<string, StoredMessage[]>();

  return {
    ensure: async (record) => {
      const existing = conversations.get(record.conversationId);
      if (existing) {
        if (existing.ownerId !== record.ownerId) throw new ConversationConflictError('owner');
        if (existing.mode !== record.mode) throw new ConversationConflictError('mode');
        if (existing.isWork !== record.isWork) throw new ConversationConflictError('kind');
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
      // A transcript is a persistence sink like any other: a pasted credential
      // is removed before it is stored, so it cannot be replayed to a model.
      list.push({ ...message, text: redactContent(message.text) });
      messages.set(message.conversationId, list);
      existing.updatedAt = message.createdAt;
      return true;
    },
    messages: async ({ ownerId, conversationId, mode }) => {
      const record = conversations.get(conversationId);
      if (!record || record.ownerId !== ownerId || record.mode !== mode) return null;
      return [...(messages.get(conversationId) ?? [])];
    },
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
