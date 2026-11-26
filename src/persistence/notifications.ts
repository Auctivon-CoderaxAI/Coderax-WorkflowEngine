import type { NotificationList } from '@coderax/contracts';
import type { NotificationRecord } from '../domain.js';

/**
 * Notifications are durable because the client that should show the blue dot may
 * have been closed when the task finished. They are written once, with the
 * terminal state the engine actually persisted, and never recomputed from a
 * client's guess.
 */
export type NotificationStore = {
  matches: (ownerId: string, taskId: string, generation: number, state: NotificationRecord['state']) => Promise<boolean>;
  record: (notification: NotificationRecord) => Promise<void>;
  list: (ownerId: string) => Promise<NotificationList>;
  markRead: (ownerId: string, taskId: string) => Promise<void>;
};

export function createNotificationStore(): NotificationStore {
  const notifications = new Map<string, NotificationRecord>();

  return {
    matches: async (ownerId, taskId, generation, state) => {
      const row = notifications.get(taskId);
      return row?.ownerId === ownerId && row.generation === generation && row.state === state;
    },
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
      if (entry && entry.ownerId === ownerId) {
        entry.read = true;
      }
    },
  };
}
