import { createNotificationDispatcher } from "~/services/notificationDispatcher.server";
import { createNotificationOutcomeService } from "~/services/notificationOutcomeService.server";
import { createNotificationLifecycleService } from "~/services/notificationLifecycle.server";
import { notificationProvider } from "~/services/notificationProvider.server";

let dispatcher: ReturnType<typeof createNotificationDispatcher> | undefined;
let stopOutcomeReconciliation: (() => Promise<void>) | undefined;
let stopLifecycle: (() => Promise<void>) | undefined;

function getDispatcher() {
  if (!dispatcher) {
    dispatcher = createNotificationDispatcher({
      provider: notificationProvider,
    });
    dispatcher.start();
    stopOutcomeReconciliation = createNotificationOutcomeService({
      provider: notificationProvider,
    }).startPeriodicReconciliation();
    stopLifecycle = createNotificationLifecycleService({
      provider: notificationProvider,
    }).startPeriodicLifecycle();
    const shutdown = () => {
      void dispatcher?.stop();
      void stopOutcomeReconciliation?.();
      void stopLifecycle?.();
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
  await Promise.all([
    dispatcher?.stop(),
    stopOutcomeReconciliation?.(),
    stopLifecycle?.(),
  ]);
}

// Route modules import the discussion service during server startup. Starting
// here makes persisted unfinished work recover even when no new post arrives.
if (process.env.NODE_ENV !== "test") getDispatcher();
