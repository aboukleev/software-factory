import {
  loadNotificationConfig,
  type NotificationConfig,
} from "~/services/notificationConfig.server";
import {
  fakeKnockAdapter,
  KnockNotificationProvider,
  type NotificationProvider,
} from "~/services/notificationProvider";

export function createNotificationProvider(
  config: NotificationConfig
): NotificationProvider {
  return config.mode === "fake"
    ? fakeKnockAdapter
    : new KnockNotificationProvider({ secretApiKey: config.secretApiKey });
}

export function getNotificationProvider(
  environment: Record<string, string | undefined> = process.env
) {
  return createNotificationProvider(loadNotificationConfig(environment));
}

// Module initialization is the server startup boundary. In Production this
// deliberately throws before a request can silently use the fake adapter.
export const notificationProvider = getNotificationProvider();
