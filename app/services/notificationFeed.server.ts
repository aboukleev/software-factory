import { and, eq } from "drizzle-orm";
import { marked } from "marked";
import { db } from "~/db";
import {
  comments,
  courses,
  enrollments,
  lessons,
  modules,
  notificationEvents,
  users,
  UserRole,
} from "~/db/schema";
import {
  fakeKnockAdapter,
  type NotificationPage,
  type ProviderNotification,
} from "~/services/notificationProvider";
import { notificationOperations } from "~/services/notificationOperations.server";

type NotificationDatabase = typeof db;
type FeedProvider = {
  list(recipientId: number): ProviderNotification[];
  listPage?(
    recipientId: number,
    options?: { cursor?: string; pageSize?: number }
  ): NotificationPage;
};
type AuthorizationCheck = (
  recipientId: number,
  courseId: number
) => boolean | Promise<boolean>;
type ActorCapacity = "student" | "instructor" | "platform_admin";

export type EnrichedNotification = ProviderNotification & {
  actorCapacity: ActorCapacity;
  availability: "available" | "unavailable" | "temporary_failure";
  courseTitle: string | null;
  lessonTitle: string | null;
  preview: string | null;
  destinationUrl: string;
  destinationAvailable: boolean;
};

function defaultAuthorizationCheck(database: NotificationDatabase) {
  return (recipientId: number, courseId: number) => {
    const person = database
      .select({ role: users.role })
      .from(users)
      .where(eq(users.id, recipientId))
      .get();
    if (!person) return false;
    if (person.role === UserRole.Admin) return true;

    const course = database
      .select({ instructorId: courses.instructorId })
      .from(courses)
      .where(eq(courses.id, courseId))
      .get();
    if (course?.instructorId === recipientId) return true;

    return Boolean(
      database
        .select({ id: enrollments.id })
        .from(enrollments)
        .where(
          and(
            eq(enrollments.userId, recipientId),
            eq(enrollments.courseId, courseId)
          )
        )
        .get()
    );
  };
}

type PreviewToken = {
  type: string;
  text?: string;
  href?: string;
  tokens?: PreviewToken[];
  items?: Array<{ tokens?: PreviewToken[] }>;
};

function previewTokenText(token: PreviewToken): string {
  if (token.type === "image" || token.type === "html") return " ";
  if (token.type === "space" || token.type === "br" || token.type === "hr") {
    return " ";
  }
  if (token.type === "list") {
    return (token.items ?? [])
      .flatMap((item) => item.tokens ?? [])
      .map(previewTokenText)
      .join(" ");
  }

  const nested = token.tokens?.map(previewTokenText).join(" ");
  const text = nested ?? token.text ?? "";
  if (
    token.type === "link" &&
    (/^(?:https?:\/\/|www\.)/i.test(text.trim()) || token.href === text.trim())
  ) {
    return " ";
  }
  return text;
}

function safePreview(markdown: string): string | null {
  const text = (marked.lexer(markdown) as unknown as PreviewToken[])
    .map(previewTokenText)
    .join(" ")
    .replace(/(?:https?:\/\/|www\.)\S+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!text) return null;
  if (text.length <= 140) return text;
  const candidate = text.slice(0, 139).trimEnd();
  const boundary = candidate.lastIndexOf(" ");
  return `${(boundary > 0 ? candidate.slice(0, boundary) : candidate).trimEnd()}…`;
}

function fallbackActorCapacity(
  notification: ProviderNotification
): ActorCapacity {
  return notification.eventKind === "question.created"
    ? "student"
    : "instructor";
}

function unavailable(
  notification: ProviderNotification,
  actorCapacity = fallbackActorCapacity(notification)
): EnrichedNotification {
  return {
    ...notification,
    actorCapacity,
    availability: "unavailable",
    courseTitle: null,
    lessonTitle: null,
    preview: null,
    destinationUrl: "/notifications/unavailable",
    destinationAvailable: false,
  };
}

function temporaryFailure(
  notification: ProviderNotification,
  actorCapacity = fallbackActorCapacity(notification)
): EnrichedNotification {
  return {
    ...notification,
    actorCapacity,
    availability: "temporary_failure",
    courseTitle: null,
    lessonTitle: null,
    preview: null,
    destinationUrl: "/notifications",
    destinationAvailable: false,
  };
}

export function createNotificationFeedService(
  database: NotificationDatabase,
  provider: FeedProvider,
  canAccess: AuthorizationCheck = defaultAuthorizationCheck(database)
) {
  async function enrich(
    recipientId: number,
    notifications: ProviderNotification[]
  ): Promise<EnrichedNotification[]> {
    return Promise.all(
      notifications.map(async (notification) => {
        let actorCapacity = fallbackActorCapacity(notification);
        try {
          const context = database
            .select({
              eventIdentity: notificationEvents.identity,
              eventKind: notificationEvents.kind,
              eventActorCapacity: notificationEvents.actorCapacity,
              eventOccurredAt: notificationEvents.occurredAt,
              eventRecipientId: notificationEvents.recipientId,
              eventCourseId: notificationEvents.courseId,
              eventLessonId: notificationEvents.lessonId,
              eventSourceCommentId: notificationEvents.sourceCommentId,
              eventRootQuestionId: notificationEvents.rootQuestionId,
              courseTitle: courses.title,
              courseSlug: courses.slug,
              lessonTitle: lessons.title,
              sourceBody: comments.body,
              sourceDeletedAt: comments.deletedAt,
              sourceParentId: comments.parentId,
            })
            .from(notificationEvents)
            .innerJoin(courses, eq(notificationEvents.courseId, courses.id))
            .innerJoin(lessons, eq(notificationEvents.lessonId, lessons.id))
            .innerJoin(modules, eq(lessons.moduleId, modules.id))
            .innerJoin(
              comments,
              eq(notificationEvents.sourceCommentId, comments.id)
            )
            .where(
              and(
                eq(notificationEvents.identity, notification.eventIdentity),
                eq(modules.courseId, courses.id),
                eq(comments.lessonId, lessons.id)
              )
            )
            .get();
          actorCapacity = context?.eventActorCapacity ?? actorCapacity;

          const valid =
            context &&
            context.eventKind === notification.eventKind &&
            context.eventOccurredAt === notification.occurredAt &&
            context.eventRecipientId === recipientId &&
            context.eventRecipientId === notification.recipientId &&
            context.eventCourseId === notification.courseId &&
            context.eventLessonId === notification.lessonId &&
            context.eventSourceCommentId === notification.sourceCommentId &&
            context.eventRootQuestionId === notification.rootQuestionId &&
            context.sourceDeletedAt === null &&
            (notification.eventKind === "question.created"
              ? context.sourceParentId === null &&
                context.eventRootQuestionId === context.eventSourceCommentId
              : context.sourceParentId === context.eventRootQuestionId);

          if (
            !valid ||
            !(await canAccess(recipientId, notification.courseId))
          ) {
            return unavailable(notification, actorCapacity);
          }

          const anchor =
            notification.eventKind === "staff-reply.created"
              ? "reply"
              : "question";
          return {
            ...notification,
            actorCapacity,
            availability: "available" as const,
            courseTitle: context.courseTitle,
            lessonTitle: context.lessonTitle,
            preview: safePreview(context.sourceBody),
            destinationUrl: `/courses/${context.courseSlug}/lessons/${context.eventLessonId}#${anchor}-${context.eventSourceCommentId}`,
            destinationAvailable: true,
          };
        } catch {
          return temporaryFailure(notification, actorCapacity);
        }
      })
    );
  }

  return {
    async list(recipientId: number): Promise<EnrichedNotification[]> {
      return enrich(recipientId, provider.list(recipientId));
    },
    async listPage(
      recipientId: number,
      options: { cursor?: string; pageSize?: number } = {}
    ) {
      const page = provider.listPage
        ? provider.listPage(recipientId, options)
        : (() => {
            const items = provider.list(recipientId);
            const offset = options.cursor
              ? Number.parseInt(options.cursor, 10)
              : 0;
            const safeOffset =
              Number.isFinite(offset) && offset >= 0 ? offset : 0;
            const pageSize = options.pageSize ?? 20;
            const pageItems = items.slice(safeOffset, safeOffset + pageSize);
            const nextOffset = safeOffset + pageItems.length;
            return {
              items: pageItems,
              unreadCount: items.filter((item) => item.readAt === null).length,
              nextCursor: nextOffset < items.length ? String(nextOffset) : null,
            };
          })();

      return { ...page, items: await enrich(recipientId, page.items) };
    },
  };
}

export function getNotificationFeed(
  userId: number,
  canAccess?: AuthorizationCheck
) {
  if (!notificationOperations.getControls().feedEnabled)
    return Promise.resolve([]);
  return createNotificationFeedService(db, fakeKnockAdapter, canAccess).list(
    userId
  );
}

export function getNotificationFeedPage(
  userId: number,
  options: { cursor?: string; pageSize?: number } = {},
  canAccess?: AuthorizationCheck
) {
  if (!notificationOperations.getControls().feedEnabled) {
    return Promise.resolve({ items: [], unreadCount: 0, nextCursor: null });
  }
  return createNotificationFeedService(
    db,
    fakeKnockAdapter,
    canAccess
  ).listPage(userId, options);
}
