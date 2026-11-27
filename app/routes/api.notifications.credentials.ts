import { data } from "react-router";
import { requireNotificationFeedAccess } from "~/services/notificationAccess.server";
import { loadNotificationConfig } from "~/services/notificationConfig.server";
import { createKnockUserToken } from "~/services/notificationSecurity.server";
import type { Route } from "./+types/api.notifications.credentials";

export async function loader({ request }: Route.LoaderArgs) {
  const { userId } = await requireNotificationFeedAccess(request);

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
