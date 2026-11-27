import { z } from "zod";
import { requireNotificationFeedAccess } from "~/services/notificationAccess.server";
import { notificationProvider } from "~/services/notificationProvider.server";
import { createNotificationReadService } from "~/services/notificationReadService";
import type { Route } from "./+types/notifications.read";

const notificationReads = createNotificationReadService(notificationProvider);
const readInputSchema = z.discriminatedUnion("intent", [
  z.object({ intent: z.literal("mark-all") }).strict(),
  z
    .object({
      intent: z.literal("mark-read"),
      notificationId: z.string().min(1).max(255),
    })
    .strict(),
]);

export async function action({ request }: Route.ActionArgs) {
  const { userId } = await requireNotificationFeedAccess(request);
  const formData = await request.formData();
  const parsed = readInputSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success)
    throw new Response("Invalid read mutation", { status: 400 });
  const result =
    parsed.data.intent === "mark-all"
      ? await notificationReads.markAllRead(userId)
      : await notificationReads.markRead(userId, parsed.data.notificationId);
  if (!result.ok) throw Response.json({ ok: false }, { status: 503 });
  return Response.json({ ok: true });
}
