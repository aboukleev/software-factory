import { data, redirect } from "react-router";
import { and, eq } from "drizzle-orm";
import { db } from "~/db";
import { courses, lessons, modules } from "~/db/schema";
import { getCurrentUserId } from "~/lib/session";
import { fakeKnockAdapter } from "~/services/notificationProvider";
import type { Route } from "./+types/notifications.read";

export async function action({ request }: Route.ActionArgs) {
  const userId = await getCurrentUserId(request);
  if (!userId) throw data("You must be logged in", { status: 401 });

  const formData = await request.formData();
  const notificationId = formData.get("notificationId");
  if (typeof notificationId !== "string") {
    throw data("Notification not found", { status: 404 });
  }
  const notification = fakeKnockAdapter
    .list(userId)
    .find((item) => item.id === notificationId);
  if (!notification || !fakeKnockAdapter.markRead(userId, notificationId)) {
    throw data("Notification not found", { status: 404 });
  }

  const destination = db
    .select({ slug: courses.slug })
    .from(lessons)
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .innerJoin(courses, eq(modules.courseId, courses.id))
    .where(
      and(
        eq(lessons.id, notification.lessonId),
        eq(courses.id, notification.courseId)
      )
    )
    .get();
  if (!destination) throw data("Notification not found", { status: 404 });

  return redirect(
    `/courses/${destination.slug}/lessons/${notification.lessonId}#question-${notification.rootQuestionId}`
  );
}
