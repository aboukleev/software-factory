import { createNotificationDispatcher } from "~/services/notificationDispatcher.server";
import { createNotificationOutcomeService } from "~/services/notificationOutcomeService.server";
import { notificationProvider } from "~/services/notificationProvider.server";

let dispatcher: ReturnType<typeof createNotificationDispatcher> | undefined;
let stopOutcomeReconciliation: (() => Promise<void>) | undefined;

function getDispatcher() {
  if (!dispatcher) {
    dispatcher = createNotificationDispatcher({
      provider: notificationProvider,
    });
    dispatcher.start();
    stopOutcomeReconciliation = createNotificationOutcomeService({
      provider: notificationProvider,
    }).startPeriodicReconciliation();
    const shutdown = () => {
      void dispatcher?.stop();
      void stopOutcomeReconciliation?.();
    };
    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);
  }
  return dispatcher;
}

export function wakeNotificationDispatcher() {
  getDispatcher().wake();
}

export async function stopNotificationDispatcher() {
  await Promise.all([dispatcher?.stop(), stopOutcomeReconciliation?.()]);
}

// Route modules import the discussion service during server startup. Starting
// here makes persisted unfinished work recover even when no new post arrives.
if (process.env.NODE_ENV !== "test") getDispatcher();
