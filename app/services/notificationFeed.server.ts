import { and, eq } from "drizzle-orm";
import { db } from "~/db";
import { courses, lessons, modules } from "~/db/schema";
import { fakeKnockAdapter } from "~/services/notificationProvider";

function enrichNotification(
  notification: ReturnType<typeof fakeKnockAdapter.list>[number]
) {
  const context = db
    .select({
      courseTitle: courses.title,
      courseSlug: courses.slug,
      lessonTitle: lessons.title,
    })
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

  return {
    ...notification,
    courseTitle: context?.courseTitle ?? "Details unavailable",
    lessonTitle: context?.lessonTitle ?? "Conversation unavailable",
    destinationUrl: context
      ? `/courses/${context.courseSlug}/lessons/${notification.lessonId}#${
          notification.eventKind === "staff-reply.created"
            ? "reply"
            : "question"
        }-${notification.sourceCommentId}`
      : "/notifications/unavailable",
    destinationAvailable: Boolean(context),
  };
}

export function getNotificationFeedPage(
  userId: number,
  options: { cursor?: string; pageSize?: number } = {}
) {
  const page = fakeKnockAdapter.listPage(userId, options);
  return {
    ...page,
    items: page.items.map(enrichNotification),
  };
}

export function getNotificationFeed(userId: number) {
  return fakeKnockAdapter.list(userId).map(enrichNotification);
}
