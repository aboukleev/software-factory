import { data } from "react-router";
import { getAccess } from "~/lib/access.server";
import { getCurrentUserId } from "~/lib/session";
import { notificationOperations } from "~/services/notificationOperations.server";

export async function requireNotificationFeedAccess(request: Request) {
  const userId = await getCurrentUserId(request);
  if (!userId) throw data("You must be logged in", { status: 401 });
  if (!notificationOperations.getControls().feedEnabled) {
    throw data("The Notification Feed is disabled", { status: 404 });
  }

  return {
    userId,
    async canAccessCourse(recipientId: number, courseId: number) {
      if (recipientId !== userId) return false;
      const access = await getAccess(request, courseId);
      return access.userId === recipientId && access.canViewContent;
    },
  };
}
