import { z } from "zod";
import type { NotificationFeedPage } from "~/components/notification-feed";

export const notificationPageEvent = "cadence:notification-page";
export const notificationRefreshEvent = "cadence:notification-refresh";
export const notificationRefreshFailedEvent =
  "cadence:notification-refresh-failed";
export const notificationSessionClearedEvent =
  "cadence:notification-session-cleared";

const notificationTabHintSchema = z
  .object({
    type: z.enum(["refresh", "session-change"]),
  })
  .strict();

export type NotificationTabHint = z.infer<typeof notificationTabHintSchema>;

export function notificationChannelName(personId: number) {
  return `cadence:notifications:${personId}`;
}

export function parseNotificationTabHint(value: unknown) {
  const parsed = notificationTabHintSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function requestNotificationReconciliation(
  broadcast = false,
  reason = "local"
) {
  window.dispatchEvent(
    new CustomEvent(notificationRefreshEvent, {
      detail: { broadcast, reason },
    })
  );
}

export function publishNotificationPage(page: NotificationFeedPage) {
  window.dispatchEvent(
    new CustomEvent<NotificationFeedPage>(notificationPageEvent, {
      detail: page,
    })
  );
}
