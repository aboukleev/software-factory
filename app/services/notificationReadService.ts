export interface NotificationReadProvider {
  markRead(
    recipientId: number,
    notificationId: string
  ): boolean | Promise<boolean>;
  markAllRead(recipientId: number): boolean | Promise<boolean>;
}

export type NotificationReadResult =
  { ok: true } | { ok: false; reason: "provider-rejected" };

export function createNotificationReadService(
  provider: NotificationReadProvider
) {
  return {
    async markRead(
      recipientId: number,
      notificationId: string
    ): Promise<NotificationReadResult> {
      try {
        return (await provider.markRead(recipientId, notificationId))
          ? { ok: true }
          : { ok: false, reason: "provider-rejected" };
      } catch {
        return { ok: false, reason: "provider-rejected" };
      }
    },

    async markAllRead(recipientId: number): Promise<NotificationReadResult> {
      try {
        return (await provider.markAllRead(recipientId))
          ? { ok: true }
          : { ok: false, reason: "provider-rejected" };
      } catch {
        return { ok: false, reason: "provider-rejected" };
      }
    },
  };
}
