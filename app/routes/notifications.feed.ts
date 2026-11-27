import { z } from "zod";
import { requireNotificationFeedAccess } from "~/services/notificationAccess.server";
import { getNotificationFeedPage } from "~/services/notificationFeed.server";
import type { Route } from "./+types/notifications.feed";

export async function loader({ request }: Route.LoaderArgs) {
  const { userId, canAccessCourse } =
    await requireNotificationFeedAccess(request);
  const parsed = z
    .object({ cursor: z.string().min(1).max(1_000).optional() })
    .strict()
    .safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsed.success)
    throw new Response("Invalid Feed cursor", { status: 400 });
  return getNotificationFeedPage(
    userId,
    { cursor: parsed.data.cursor },
    canAccessCourse
  );
}
