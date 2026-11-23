import { data } from "react-router";
import { getCurrentUserId } from "~/lib/session";
import { fakeKnockAdapter } from "~/services/notificationProvider";
import { createNotificationReadService } from "~/services/notificationReadService";
import type { Route } from "./+types/notifications.read";

const notificationReads = createNotificationReadService(fakeKnockAdapter);

export async function action({ request }: Route.ActionArgs) {
  const userId = await getCurrentUserId(request);
  if (!userId) throw data("You must be logged in", { status: 401 });

  const formData = await request.formData();
  const intent = formData.get("intent");
  const notificationId = formData.get("notificationId");
  const result =
    intent === "mark-all"
      ? notificationReads.markAllRead(userId)
      : intent === "mark-read" && typeof notificationId === "string"
        ? notificationReads.markRead(userId, notificationId)
        : { ok: false as const };

  return Response.json({ ok: result.ok }, { status: result.ok ? 200 : 503 });
}
