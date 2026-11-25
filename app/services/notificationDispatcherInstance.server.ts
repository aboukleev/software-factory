import { createNotificationDispatcher } from "~/services/notificationDispatcher.server";
import { notificationProvider } from "~/services/notificationProvider.server";

let dispatcher: ReturnType<typeof createNotificationDispatcher> | undefined;

function getDispatcher() {
  if (!dispatcher) {
    dispatcher = createNotificationDispatcher({
      provider: notificationProvider,
    });
    dispatcher.start();
    const shutdown = () => {
      void dispatcher?.stop();
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
  await dispatcher?.stop();
}

// Route modules import the discussion service during server startup. Starting
// here makes persisted unfinished work recover even when no new post arrives.
if (process.env.NODE_ENV !== "test") getDispatcher();
