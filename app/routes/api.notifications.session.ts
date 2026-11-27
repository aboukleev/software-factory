import { requireNotificationFeedAccess } from "~/services/notificationAccess.server";
import type { Route } from "./+types/api.notifications.session";

export async function loader({ request }: Route.LoaderArgs) {
  const { userId } = await requireNotificationFeedAccess(request);
  return Response.json(
    { userId },
    { headers: { "Cache-Control": "no-store" } }
  );
}
