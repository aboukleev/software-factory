import { describe, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import {
  comments,
  courses,
  enrollments,
  lessons,
  modules,
  notificationEvents,
} from "~/db/schema";
import { createTestDb, seedBaseData } from "~/test/setup";
import { createDiscussionPost } from "~/services/discussionService";
import { createNotificationFeedService } from "~/services/notificationFeed.server";
import { FakeKnockAdapter } from "~/services/notificationProvider";
import { createNotificationDispatcher } from "~/services/notificationDispatcher.server";

async function dispatchQueued(
  database: ReturnType<typeof createTestDb>,
  provider: FakeKnockAdapter
) {
  await createNotificationDispatcher({ database, provider }).runOnce();
}

describe("Notification Feed enrichment", () => {
  test("shows current authorized context and a safe Question preview", async () => {
    const database = createTestDb();
    const { user, instructor, course } = seedBaseData(database);
    const lessonModule = database
      .insert(modules)
      .values({ courseId: course.id, title: "Module", position: 1 })
      .returning()
      .get();
    const lesson = database
      .insert(lessons)
      .values({
        moduleId: lessonModule.id,
        title: "Original lesson",
        position: 1,
      })
      .returning()
      .get();
    database
      .insert(enrollments)
      .values({ userId: user.id, courseId: course.id })
      .run();
    const provider = new FakeKnockAdapter();

    const result = createDiscussionPost(
      {
        authorization: { userId: user.id, courseId: course.id },
        lessonId: lesson.id,
        parentId: null,
        body: "## Need **help** with [this guide](https://secret.example/guide) ![private diagram](https://secret.example/image.png)",
      },
      database,
      () => undefined
    );
    await dispatchQueued(database, provider);
    database
      .update(courses)
      .set({ title: "Renamed course" })
      .where(eq(courses.id, course.id))
      .run();
    database
      .update(lessons)
      .set({ title: "Renamed lesson" })
      .where(eq(lessons.id, lesson.id))
      .run();
    database
      .update(comments)
      .set({ body: "Edited _Question_ at https://secret.example/raw" })
      .where(eq(comments.id, result.source.id))
      .run();

    const [item] = await createNotificationFeedService(database, provider).list(
      instructor.id
    );

    expect(item).toMatchObject({
      courseTitle: "Renamed course",
      lessonTitle: "Renamed lesson",
      preview: "Edited Question at",
      destinationUrl: `/courses/test-course/lessons/${lesson.id}#question-${result.source.id}`,
      availability: "available",
    });
    expect(item.occurredAt).toBe(result.source.createdAt);
  });

  test("previews the current Reply and keeps it reachable below a deleted Question", async () => {
    const database = createTestDb();
    const { user, instructor, course } = seedBaseData(database);
    const lessonModule = database
      .insert(modules)
      .values({ courseId: course.id, title: "Module", position: 1 })
      .returning()
      .get();
    const lesson = database
      .insert(lessons)
      .values({ moduleId: lessonModule.id, title: "Lesson", position: 1 })
      .returning()
      .get();
    database
      .insert(enrollments)
      .values({ userId: user.id, courseId: course.id })
      .run();
    const provider = new FakeKnockAdapter();
    const question = createDiscussionPost(
      {
        authorization: { userId: user.id, courseId: course.id },
        lessonId: lesson.id,
        parentId: null,
        body: "Original Question",
      },
      database,
      () => undefined
    ).source;
    const reply = createDiscussionPost(
      {
        authorization: { userId: instructor.id, courseId: course.id },
        lessonId: lesson.id,
        parentId: question.id,
        body: "Original Reply",
      },
      database,
      () => undefined
    ).source;
    await dispatchQueued(database, provider);
    database
      .update(comments)
      .set({ deletedAt: new Date().toISOString() })
      .where(eq(comments.id, question.id))
      .run();
    database
      .update(comments)
      .set({ body: "Edited **Reply**" })
      .where(eq(comments.id, reply.id))
      .run();

    const items = await createNotificationFeedService(database, provider).list(
      user.id
    );
    const item = items.find(
      (candidate) => candidate.sourceCommentId === reply.id
    );

    expect(item).toMatchObject({
      availability: "available",
      preview: "Edited Reply",
      destinationUrl: `/courses/test-course/lessons/${lesson.id}#reply-${reply.id}`,
    });
  });

  test("does not distinguish deleted, unauthorized, or tampered conversation context", async () => {
    const database = createTestDb();
    const { user, instructor, course } = seedBaseData(database);
    const lessonModule = database
      .insert(modules)
      .values({ courseId: course.id, title: "Secret module", position: 1 })
      .returning()
      .get();
    const lesson = database
      .insert(lessons)
      .values({
        moduleId: lessonModule.id,
        title: "Secret lesson",
        position: 1,
      })
      .returning()
      .get();
    database
      .insert(enrollments)
      .values({ userId: user.id, courseId: course.id })
      .run();
    const provider = new FakeKnockAdapter();
    const question = createDiscussionPost(
      {
        authorization: { userId: user.id, courseId: course.id },
        lessonId: lesson.id,
        parentId: null,
        body: "Secret Question",
      },
      database,
      () => undefined
    ).source;
    await dispatchQueued(database, provider);

    database.delete(enrollments).where(eq(enrollments.userId, user.id)).run();
    database
      .update(comments)
      .set({ deletedAt: new Date().toISOString() })
      .where(eq(comments.id, question.id))
      .run();
    const durableEvent = database.select().from(notificationEvents).get();
    const original = provider.list(instructor.id)[0];
    if (!durableEvent || !original)
      throw new Error("Expected a delivered Notification");
    const tamperedProvider = {
      listPage: () => ({
        items: [
          {
            ...original,
            eventIdentity: durableEvent.identity,
            lessonId: lesson.id + 999,
          },
        ],
        unreadCount: 1,
        nextCursor: null,
      }),
    };

    const [deleted] = await createNotificationFeedService(
      database,
      provider
    ).list(instructor.id);
    const [unauthorized] = await createNotificationFeedService(
      database,
      provider,
      () => false
    ).list(instructor.id);
    const [tampered] = await createNotificationFeedService(
      database,
      tamperedProvider
    ).list(instructor.id);

    for (const item of [deleted, unauthorized, tampered]) {
      expect(item).toMatchObject({
        availability: "unavailable",
        courseTitle: null,
        lessonTitle: null,
        preview: null,
        destinationUrl: "/notifications/unavailable",
      });
    }
  });

  test("keeps transient enrichment failure retryable", async () => {
    const database = createTestDb();
    const { user, instructor, course } = seedBaseData(database);
    const lessonModule = database
      .insert(modules)
      .values({ courseId: course.id, title: "Module", position: 1 })
      .returning()
      .get();
    const lesson = database
      .insert(lessons)
      .values({ moduleId: lessonModule.id, title: "Lesson", position: 1 })
      .returning()
      .get();
    database
      .insert(enrollments)
      .values({ userId: user.id, courseId: course.id })
      .run();
    const provider = new FakeKnockAdapter();
    createDiscussionPost(
      {
        authorization: { userId: user.id, courseId: course.id },
        lessonId: lesson.id,
        parentId: null,
        body: "Question",
      },
      database,
      () => undefined
    );
    await dispatchQueued(database, provider);
    let attempts = 0;
    const service = createNotificationFeedService(database, provider, () => {
      attempts += 1;
      if (attempts === 1) throw new Error("database temporarily unavailable");
      return true;
    });

    const [failed] = await service.list(instructor.id);
    const [retried] = await service.list(instructor.id);

    expect(failed).toMatchObject({
      availability: "temporary_failure",
      courseTitle: null,
      lessonTitle: null,
      preview: null,
    });
    expect(retried).toMatchObject({
      availability: "available",
      courseTitle: "Test Course",
      lessonTitle: "Lesson",
    });
  });

  test("omits unsafe or empty Markdown and truncates previews at a word boundary", async () => {
    const database = createTestDb();
    const { user, instructor, course } = seedBaseData(database);
    const lessonModule = database
      .insert(modules)
      .values({ courseId: course.id, title: "Module", position: 1 })
      .returning()
      .get();
    const lesson = database
      .insert(lessons)
      .values({ moduleId: lessonModule.id, title: "Lesson", position: 1 })
      .returning()
      .get();
    database
      .insert(enrollments)
      .values({ userId: user.id, courseId: course.id })
      .run();
    const provider = new FakeKnockAdapter();
    const question = createDiscussionPost(
      {
        authorization: { userId: user.id, courseId: course.id },
        lessonId: lesson.id,
        parentId: null,
        body: "Initial Question",
      },
      database,
      () => undefined
    ).source;
    await dispatchQueued(database, provider);
    const service = createNotificationFeedService(database, provider);

    database
      .update(comments)
      .set({
        body: "## [Useful **label**](https://secret.example/guide)\n![private diagram](https://secret.example/image.png) raw https://secret.example/raw",
      })
      .where(eq(comments.id, question.id))
      .run();
    expect((await service.list(instructor.id))[0]?.preview).toBe(
      "Useful label raw"
    );

    database
      .update(comments)
      .set({
        body: "![private diagram](https://secret.example/image.png) https://secret.example/raw",
      })
      .where(eq(comments.id, question.id))
      .run();
    expect((await service.list(instructor.id))[0]?.preview).toBeNull();

    database
      .update(comments)
      .set({ body: Array.from({ length: 40 }, () => "preview").join(" ") })
      .where(eq(comments.id, question.id))
      .run();
    const preview = (await service.list(instructor.id))[0]?.preview;
    expect(preview?.length).toBeLessThanOrEqual(140);
    expect(preview).toMatch(/ preview…$/);
  });
});
