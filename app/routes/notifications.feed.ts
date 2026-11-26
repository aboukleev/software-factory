import { data } from "react-router";
import { getAccess } from "~/lib/access.server";
import { getCurrentUserId } from "~/lib/session";
import { getNotificationFeedPage } from "~/services/notificationFeed.server";
import { notificationOperations } from "~/services/notificationOperations.server";
import type { Route } from "./+types/notifications.feed";

export async function loader({ request }: Route.LoaderArgs) {
  const userId = await getCurrentUserId(request);
  if (!userId) throw data("You must be logged in", { status: 401 });
  if (!notificationOperations.getControls().feedEnabled) {
    throw data("The Notification Feed is disabled", { status: 404 });
  }

  const cursor = new URL(request.url).searchParams.get("cursor") ?? undefined;
  return getNotificationFeedPage(
    userId,
    { cursor },
    async (recipientId, courseId) => {
      const access = await getAccess(request, courseId);
      return access.userId === recipientId && access.canViewContent;
    }
  );
}
