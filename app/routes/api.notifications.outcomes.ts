import { createNotificationOutcomeService } from "~/services/notificationOutcomeService.server";
import { createNotificationOutcomeAction } from "~/services/notificationOutcomeWebhook.server";
import { notificationProvider } from "~/services/notificationProvider.server";

const outcomeService = createNotificationOutcomeService({
  provider: notificationProvider,
});

export const action = createNotificationOutcomeAction({
  secret: process.env.KNOCK_WEBHOOK_SECRET ?? "",
  recordOutcome: outcomeService.recordOutcome,
});
