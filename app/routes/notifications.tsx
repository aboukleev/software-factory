import { NotificationFeed } from "~/components/notification-feed";
import { getNotificationFeedPage } from "~/services/notificationFeed.server";
import { requireNotificationFeedAccess } from "~/services/notificationAccess.server";
import type { Route } from "./+types/notifications";

export async function loader({ request }: Route.LoaderArgs) {
  const { userId, canAccessCourse } =
    await requireNotificationFeedAccess(request);
  return {
    notificationFeed: await getNotificationFeedPage(
      userId,
      {},
      canAccessCourse
    ),
  };
}

export default function NotificationsPage({
  loaderData,
}: Route.ComponentProps) {
  return (
    <div className="mx-auto max-w-3xl p-6">
      <section aria-label="Notification Feed" className="rounded-lg border p-4">
        <NotificationFeed initialPage={loaderData.notificationFeed} full />
      </section>
    </div>
  );
}
