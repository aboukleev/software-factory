import { data } from "react-router";
import { getCurrentUserId } from "~/lib/session";
import { notificationOperations } from "~/services/notificationOperations.server";
import type { Route } from "./+types/api.notifications.session";

export async function loader({ request }: Route.LoaderArgs) {
  const userId = await getCurrentUserId(request);
  if (!userId) throw data("You must be logged in", { status: 401 });
  if (!notificationOperations.getControls().feedEnabled) {
    throw data("The Notification Feed is disabled", { status: 404 });
  }
  return Response.json(
    { userId },
    { headers: { "Cache-Control": "no-store" } }
  );
}
