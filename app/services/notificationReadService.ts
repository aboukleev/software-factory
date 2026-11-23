export interface NotificationReadProvider {
  markRead(recipientId: number, notificationId: string): boolean;
  markAllRead(recipientId: number): boolean;
}

export type NotificationReadResult =
  { ok: true } | { ok: false; reason: "provider-rejected" };

export function createNotificationReadService(
  provider: NotificationReadProvider
) {
  return {
    markRead(
      recipientId: number,
      notificationId: string
    ): NotificationReadResult {
      try {
        return provider.markRead(recipientId, notificationId)
          ? { ok: true }
          : { ok: false, reason: "provider-rejected" };
      } catch {
        return { ok: false, reason: "provider-rejected" };
      }
    },

    markAllRead(recipientId: number): NotificationReadResult {
      try {
        return provider.markAllRead(recipientId)
          ? { ok: true }
          : { ok: false, reason: "provider-rejected" };
      } catch {
        return { ok: false, reason: "provider-rejected" };
      }
    },
  };
}
