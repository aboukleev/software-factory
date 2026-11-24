import { data } from "react-router";
import { NotificationFeed } from "~/components/notification-feed";
import { getCurrentUserId } from "~/lib/session";
import { getNotificationFeedPage } from "~/services/notificationFeed.server";
import type { Route } from "./+types/notifications";

export async function loader({ request }: Route.LoaderArgs) {
  const userId = await getCurrentUserId(request);
  if (!userId) throw data("You must be logged in", { status: 401 });
  return { notificationFeed: getNotificationFeedPage(userId) };
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
