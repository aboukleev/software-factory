import { data } from "react-router";
import { getCurrentUserId } from "~/lib/session";
import { loadNotificationConfig } from "~/services/notificationConfig.server";
import { createKnockUserToken } from "~/services/notificationSecurity.server";
import { notificationOperations } from "~/services/notificationOperations.server";
import type { Route } from "./+types/api.notifications.credentials";

export async function loader({ request }: Route.LoaderArgs) {
  const userId = await getCurrentUserId(request);
  if (!userId) throw data("You must be logged in", { status: 401 });
  if (!notificationOperations.getControls().feedEnabled) {
    throw data("The Notification Feed is disabled", { status: 404 });
  }

  const config = loadNotificationConfig();
  if (config.mode !== "knock") {
    throw data("The live Notification Feed is disabled", { status: 404 });
  }

  return Response.json(
    {
      userId: String(userId),
      publicApiKey: config.publicApiKey,
      feedChannelId: config.feedChannelId,
      userToken: createKnockUserToken(userId, config.signingKey),
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
