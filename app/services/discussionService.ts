import { and, eq, inArray } from "drizzle-orm";
import { db } from "~/db";
import {
  comments,
  courses,
  enrollments,
  lessons,
  modules,
  notificationDeliveries,
  notificationEvents,
  users,
  UserRole,
} from "~/db/schema";
import { MAX_COMMENT_LENGTH, MIN_COMMENT_LENGTH } from "~/lib/comments";
import type { NotificationPayload } from "~/services/notificationProvider";
import { wakeNotificationDispatcher } from "~/services/notificationDispatcherInstance.server";

type DiscussionDatabase = typeof db;

type DiscussionAuthorization = {
  userId: number;
  courseId: number;
};

type CreateDiscussionPostInput = {
  authorization: DiscussionAuthorization | null;
  lessonId: number;
  parentId: number | null;
  body: string;
};

type DeleteDiscussionPostInput = {
  commentId: number;
  userId: number;
  isStaff: boolean;
};

export function deleteDiscussionPost(
  input: DeleteDiscussionPostInput,
  database: DiscussionDatabase = db,
  now: () => Date = () => new Date()
) {
  return database.transaction((tx) => {
    const existing = tx
      .select()
      .from(comments)
      .where(eq(comments.id, input.commentId))
      .get();
    if (!existing) throw new Error("Comment not found");
    if (existing.userId !== input.userId && !input.isStaff) {
      throw new Error("You can only delete your own comments");
    }
    if (existing.deletedAt !== null) return existing;

    const deletedAt = now().toISOString();
    const deleted = tx
      .update(comments)
      .set({ deletedAt })
      .where(eq(comments.id, input.commentId))
      .returning()
      .get();

    const event = tx
      .select({ id: notificationEvents.id })
      .from(notificationEvents)
      .where(eq(notificationEvents.sourceCommentId, input.commentId))
      .get();
    if (event) {
      tx.update(notificationDeliveries)
        .set({
          status: "cancelled",
          terminalAt: deletedAt,
          errorCategory: "source_deleted_before_acceptance",
          leaseOwner: null,
          leaseExpiresAt: null,
        })
        .where(
          and(
            eq(notificationDeliveries.notificationEventId, event.id),
            inArray(notificationDeliveries.status, [
              "queued",
              "retry_scheduled",
            ])
          )
        )
        .run();
    }

    return deleted;
  });
}

export function createDiscussionPost(
  input: CreateDiscussionPostInput,
  database: DiscussionDatabase = db,
  wakeDispatcher: () => void = wakeNotificationDispatcher
) {
  let shouldWakeDispatcher = false;
  const result = database.transaction((tx) => {
    const trimmed = input.body.trim();
    if (trimmed.length < MIN_COMMENT_LENGTH) {
      throw new Error("Comment cannot be empty");
    }
    if (trimmed.length > MAX_COMMENT_LENGTH) {
      throw new Error(
        `Comment must be ${MAX_COMMENT_LENGTH} characters or fewer`
      );
    }

    const course = tx
      .select({
        id: courses.id,
        title: courses.title,
        slug: courses.slug,
        instructorId: courses.instructorId,
      })
      .from(lessons)
      .innerJoin(modules, eq(lessons.moduleId, modules.id))
      .innerJoin(courses, eq(modules.courseId, courses.id))
      .where(eq(lessons.id, input.lessonId))
      .get();

    if (!course) {
      throw new Error("Lesson not found");
    }
    if (!input.authorization || input.authorization.courseId !== course.id) {
      throw new Error("Not authorized to post in this course");
    }

    let parent: typeof comments.$inferSelect | undefined;
    if (input.parentId !== null) {
      parent = tx
        .select()
        .from(comments)
        .where(eq(comments.id, input.parentId))
        .get();
      if (!parent) {
        throw new Error("Parent comment not found");
      }
      if (parent.lessonId !== input.lessonId) {
        throw new Error("Parent comment belongs to a different lesson");
      }
      if (parent.parentId !== null) {
        throw new Error("Replies can only be one level deep");
      }
    }

    const source = tx
      .insert(comments)
      .values({
        userId: input.authorization.userId,
        lessonId: input.lessonId,
        parentId: input.parentId,
        body: trimmed,
      })
      .returning()
      .get();

    if (input.parentId === null) {
      const actor = tx
        .select({ role: users.role })
        .from(users)
        .where(eq(users.id, input.authorization.userId))
        .get();
      const enrollment = tx
        .select({ id: enrollments.id })
        .from(enrollments)
        .where(
          and(
            eq(enrollments.userId, input.authorization.userId),
            eq(enrollments.courseId, course.id)
          )
        )
        .get();

      if (
        actor?.role === UserRole.Student &&
        enrollment &&
        input.authorization.userId !== course.instructorId
      ) {
        const identity = `question.created:${source.id}`;
        const event = tx
          .insert(notificationEvents)
          .values({
            identity,
            kind: "question.created",
            occurredAt: source.createdAt,
            sourceCommentId: source.id,
            rootQuestionId: source.id,
            actorId: input.authorization.userId,
            actorCapacity: "student",
            recipientId: course.instructorId,
            courseId: course.id,
            lessonId: input.lessonId,
          })
          .returning()
          .get();
        const idempotencyKey = `${identity}:${course.instructorId}:in_app`;
        const payload: NotificationPayload = {
          eventIdentity: identity,
          eventKind: "question.created",
          occurredAt: source.createdAt,
          sourceCommentId: source.id,
          rootQuestionId: source.id,
          recipientId: course.instructorId,
          courseId: course.id,
          lessonId: input.lessonId,
        };
        tx.insert(notificationDeliveries)
          .values({
            notificationEventId: event.id,
            recipientId: course.instructorId,
            channel: "in_app",
            workflowKey: "student-question-created",
            idempotencyKey,
            providerPayload: JSON.stringify(payload),
            status: "queued",
            nextAttemptAt: source.createdAt,
          })
          .run();
        shouldWakeDispatcher = true;
      }
    } else if (parent) {
      const qualifyingQuestion = tx
        .select()
        .from(notificationEvents)
        .where(
          and(
            eq(notificationEvents.kind, "question.created"),
            eq(notificationEvents.sourceCommentId, parent.id)
          )
        )
        .get();
      const actor = tx
        .select({ role: users.role })
        .from(users)
        .where(eq(users.id, input.authorization.userId))
        .get();
      const actorCapacity =
        actor?.role === UserRole.Admin
          ? "platform_admin"
          : input.authorization.userId === course.instructorId
            ? "instructor"
            : null;

      if (
        qualifyingQuestion &&
        qualifyingQuestion.actorId !== null &&
        actorCapacity
      ) {
        const identity = `staff-reply.created:${source.id}`;
        const recipientId = qualifyingQuestion.actorId;
        const event = tx
          .insert(notificationEvents)
          .values({
            identity,
            kind: "staff-reply.created",
            occurredAt: source.createdAt,
            sourceCommentId: source.id,
            rootQuestionId: parent.id,
            actorId: input.authorization.userId,
            actorCapacity,
            recipientId,
            courseId: course.id,
            lessonId: input.lessonId,
          })
          .returning()
          .get();

        if (input.authorization.userId !== recipientId) {
          const idempotencyKey = `${identity}:${recipientId}:in_app`;
          const payload: NotificationPayload = {
            eventIdentity: identity,
            eventKind: "staff-reply.created",
            occurredAt: source.createdAt,
            sourceCommentId: source.id,
            rootQuestionId: parent.id,
            recipientId,
            courseId: course.id,
            lessonId: input.lessonId,
          };
          tx.insert(notificationDeliveries)
            .values({
              notificationEventId: event.id,
              recipientId,
              channel: "in_app",
              workflowKey: "staff-reply-created",
              idempotencyKey,
              providerPayload: JSON.stringify(payload),
              status: "queued",
              nextAttemptAt: source.createdAt,
            })
            .run();
          shouldWakeDispatcher = true;
        }
      }
    }

    return { source, course };
  });

  if (shouldWakeDispatcher) wakeDispatcher();
  return result;
}
