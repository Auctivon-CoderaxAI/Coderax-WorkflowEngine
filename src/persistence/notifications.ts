import type { NotificationList } from '@coderax/contracts';
import type { NotificationRecord } from '../domain.js';

/**
 * Notifications are durable because the client that should show the blue dot may
 * have been closed when the task finished. They are written once, with the
 * terminal state the engine actually persisted, and never recomputed from a
 * client's guess.
 */
export type NotificationStore = {
  record: (notification: NotificationRecord) => Promise<void>;
  list: (ownerId: string) => Promise<NotificationList>;
  /** Returns false when no notification exists for that owner and task. */
  markRead: (ownerId: string, taskId: string) => Promise<boolean>;
};

export function createNotificationStore(): NotificationStore {
  const notifications = new Map<string, NotificationRecord>();

  return {
    record: async (notification) => {
      notifications.set(notification.taskId, { ...notification });
    },
    list: async (ownerId) => {
      const owned = [...notifications.values()]
        .filter((entry) => entry.ownerId === ownerId)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
      return {
        notifications: owned.map((entry) => ({
          taskId: entry.taskId,
          conversationId: entry.conversationId,
          agent: entry.agent,
          mode: entry.mode,
          state: entry.state,
          ...(entry.summary ? { summary: entry.summary } : {}),
          createdAt: entry.createdAt,
          read: entry.read,
        })),
        unread: owned.filter((entry) => !entry.read).length,
      };
    },
    markRead: async (ownerId, taskId) => {
      const entry = notifications.get(taskId);
      if (!entry || entry.ownerId !== ownerId) return false;
      entry.read = true;
      return true;
    },
  };
}
