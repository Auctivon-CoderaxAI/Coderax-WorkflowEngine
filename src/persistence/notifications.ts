import type { NotificationList } from '@coderax/contracts';
import type { NotificationRecord } from '../domain.js';
import { clampLimit, decodeCursor, encodeCursor } from './pagination.js';

export type NotificationPageInput = {
  ownerId: string;
  limit?: number;
  cursor?: string;
  unreadOnly?: boolean;
};

/**
 * Notifications are durable because the client that should show the blue dot may
 * have been closed when the task finished. They are written once, with the
 * terminal state the engine actually persisted, and never recomputed from a
 * client's guess.
 */
export type NotificationStore = {
  record: (notification: NotificationRecord) => Promise<void>;
  list: (input: NotificationPageInput | string) => Promise<NotificationList>;
  /** Marks the named tasks read for this owner; returns the affected count. */
  markRead: (ownerId: string, taskIds: readonly string[]) => Promise<number>;
  deleteByConversation: (ownerId: string, conversationId: string) => Promise<number>;
  prune: (before: string, limit: number) => Promise<number>;
};

function pageInput(input: NotificationPageInput | string): NotificationPageInput {
  return typeof input === 'string' ? { ownerId: input } : input;
}

export function createNotificationStore(): NotificationStore {
  const notifications = new Map<string, NotificationRecord>();

  function list(input: NotificationPageInput | string): NotificationList {
    const query = pageInput(input);
    const limit = clampLimit(query.limit);
    const cursor = query.cursor ? decodeCursor(query.cursor) : null;
    const owned = [...notifications.values()]
      .filter((entry) => entry.ownerId === query.ownerId)
      .filter((entry) => !query.unreadOnly || !entry.read)
      .sort(
        (left, right) =>
          right.createdAt.localeCompare(left.createdAt) || right.taskId.localeCompare(left.taskId),
      );
    const after = cursor
      ? owned.filter(
          (entry) =>
            entry.createdAt < cursor.at ||
            (entry.createdAt === cursor.at && entry.taskId < cursor.id),
        )
      : owned;
    const page = after.slice(0, limit);
    const hasMore = after.length > limit;
    return {
      notifications: page.map((entry) => ({
        taskId: entry.taskId,
        conversationId: entry.conversationId,
        agent: entry.agent,
        mode: entry.mode,
        state: entry.state,
        ...(entry.summary ? { summary: entry.summary } : {}),
        createdAt: entry.createdAt,
        read: entry.read,
      })),
      unread: [...notifications.values()].filter(
        (entry) => entry.ownerId === query.ownerId && !entry.read,
      ).length,
      total: owned.length,
      ...(hasMore && page.length > 0
        ? { nextCursor: encodeCursor(page[page.length - 1]!.createdAt, page[page.length - 1]!.taskId) }
        : {}),
    };
  }

  return {
    record: async (notification) => {
      notifications.set(notification.taskId, { ...notification });
    },
    list: async (input) => list(input),
    markRead: async (ownerId, taskIds) => {
      let changed = 0;
      for (const taskId of new Set(taskIds)) {
        const entry = notifications.get(taskId);
        if (entry && entry.ownerId === ownerId && !entry.read) {
          entry.read = true;
          changed += 1;
        }
      }
      return changed;
    },
    deleteByConversation: async (ownerId, conversationId) => {
      let deleted = 0;
      for (const [taskId, entry] of notifications) {
        if (entry.ownerId === ownerId && entry.conversationId === conversationId) {
          notifications.delete(taskId);
          deleted += 1;
        }
      }
      return deleted;
    },
    prune: async (before, limit) => {
      let deleted = 0;
      for (const [taskId, entry] of notifications) {
        if (deleted >= limit) break;
        if (entry.createdAt < before) {
          notifications.delete(taskId);
          deleted += 1;
        }
      }
      return deleted;
    },
  };
}
