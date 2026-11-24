import { data } from "react-router";
import { NotificationFeed } from "~/components/notification-feed";
import { getCurrentUserId } from "~/lib/session";
import { getAccess } from "~/lib/access.server";
import { getNotificationFeed } from "~/services/notificationFeed.server";
import type { Route } from "./+types/notifications";

export async function loader({ request }: Route.LoaderArgs) {
  const userId = await getCurrentUserId(request);
  if (!userId) throw data("You must be logged in", { status: 401 });
  return {
    notificationFeed: await getNotificationFeed(
      userId,
      async (recipientId, courseId) => {
        const access = await getAccess(request, courseId);
        return access.userId === recipientId && access.canViewContent;
      }
    ),
  };
}

export default function NotificationsPage({
  loaderData,
}: Route.ComponentProps) {
  return (
    <div className="mx-auto max-w-3xl p-6">
      <section aria-label="Notification Feed" className="rounded-lg border p-4">
        <NotificationFeed items={loaderData.notificationFeed} full />
      </section>
    </div>
  );
}
