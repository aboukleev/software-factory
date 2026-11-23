import { describe, expect, test } from "vitest";
import { createDiscussionPost } from "~/services/discussionService";
import { createTestDb, seedBaseData } from "~/test/setup";
import {
  comments,
  enrollments,
  lessons,
  modules,
  notificationDeliveries,
  notificationEvents,
} from "~/db/schema";
import { FakeKnockAdapter } from "~/services/notificationProvider";

describe("createDiscussionPost", () => {
  test("atomically records and delivers an enrolled Student Question", async () => {
    const database = createTestDb();
    const { user, instructor, course } = seedBaseData(database);
    database
      .insert(enrollments)
      .values({ userId: user.id, courseId: course.id })
      .run();
    const module = database
      .insert(modules)
      .values({ courseId: course.id, title: "Start here", position: 1 })
      .returning()
      .get();
    const lesson = database
      .insert(lessons)
      .values({ moduleId: module.id, title: "Welcome", position: 1 })
      .returning()
      .get();
    const provider = new FakeKnockAdapter();

    const result = createDiscussionPost(
      {
        authorization: { userId: user.id, courseId: course.id },
        lessonId: lesson.id,
        parentId: null,
        body: "How does this work?",
      },
      database,
      provider
    );

    const [event] = database.select().from(notificationEvents).all();
    const [delivery] = database.select().from(notificationDeliveries).all();
    expect(event).toEqual({
      id: expect.any(Number),
      identity: `question.created:${result.source.id}`,
      kind: "question.created",
      occurredAt: result.source.createdAt,
      sourceCommentId: result.source.id,
      rootQuestionId: result.source.id,
      actorId: user.id,
      actorCapacity: "student",
      recipientId: instructor.id,
      courseId: course.id,
      lessonId: lesson.id,
    });
    expect(delivery).toEqual(
      expect.objectContaining({
        notificationEventId: event.id,
        recipientId: instructor.id,
        channel: "in_app",
        workflowKey: "student-question-created",
        idempotencyKey: `question.created:${result.source.id}:${instructor.id}:in_app`,
        status: "queued",
      })
    );
    expect(JSON.parse(delivery.providerPayload)).toEqual({
      eventIdentity: `question.created:${result.source.id}`,
      occurredAt: result.source.createdAt,
      sourceCommentId: result.source.id,
      rootQuestionId: result.source.id,
      recipientId: instructor.id,
      courseId: course.id,
      lessonId: lesson.id,
    });
    expect(delivery.providerPayload).not.toContain("How does this work?");
    expect(delivery.providerPayload).not.toContain(user.name);

    await provider.settled();
    expect(provider.list(instructor.id)).toEqual([
      expect.objectContaining({
        idempotencyKey: delivery.idempotencyKey,
        readAt: null,
      }),
    ]);
  });

  test("rolls back the Question and Event when Delivery persistence fails", () => {
    const database = createTestDb();
    const { user, course } = seedBaseData(database);
    database
      .insert(enrollments)
      .values({ userId: user.id, courseId: course.id })
      .run();
    const module = database
      .insert(modules)
      .values({ courseId: course.id, title: "M", position: 1 })
      .returning()
      .get();
    const lesson = database
      .insert(lessons)
      .values({ moduleId: module.id, title: "L", position: 1 })
      .returning()
      .get();
    database.$client.exec(`
      CREATE TRIGGER reject_notification_delivery
      BEFORE INSERT ON notification_deliveries
      BEGIN SELECT RAISE(ABORT, 'simulated delivery write failure'); END;
    `);

    expect(() =>
      createDiscussionPost(
        {
          authorization: { userId: user.id, courseId: course.id },
          lessonId: lesson.id,
          parentId: null,
          body: "Will roll back",
        },
        database
      )
    ).toThrow("simulated delivery write failure");
    expect(database.select().from(comments).all()).toEqual([]);
    expect(database.select().from(notificationEvents).all()).toEqual([]);
    expect(database.select().from(notificationDeliveries).all()).toEqual([]);
  });

  test("provider failure cannot fail the committed conversation", async () => {
    const database = createTestDb();
    const { user, course } = seedBaseData(database);
    database
      .insert(enrollments)
      .values({ userId: user.id, courseId: course.id })
      .run();
    const module = database
      .insert(modules)
      .values({ courseId: course.id, title: "M", position: 1 })
      .returning()
      .get();
    const lesson = database
      .insert(lessons)
      .values({ moduleId: module.id, title: "L", position: 1 })
      .returning()
      .get();
    const provider = {
      trigger: () => {
        throw new Error("Knock unavailable");
      },
    };

    expect(() =>
      createDiscussionPost(
        {
          authorization: { userId: user.id, courseId: course.id },
          lessonId: lesson.id,
          parentId: null,
          body: "Still succeeds",
        },
        database,
        provider
      )
    ).not.toThrow();
    await Promise.resolve();
    expect(database.select().from(comments).all()).toHaveLength(1);
    expect(database.select().from(notificationEvents).all()).toHaveLength(1);
    expect(database.select().from(notificationDeliveries).all()).toHaveLength(
      1
    );
  });

  test("database rejects a second Delivery for one Event, recipient, and Channel", () => {
    const database = createTestDb();
    const { user, instructor, course } = seedBaseData(database);
    database
      .insert(enrollments)
      .values({ userId: user.id, courseId: course.id })
      .run();
    const module = database
      .insert(modules)
      .values({ courseId: course.id, title: "M", position: 1 })
      .returning()
      .get();
    const lesson = database
      .insert(lessons)
      .values({ moduleId: module.id, title: "L", position: 1 })
      .returning()
      .get();
    createDiscussionPost(
      {
        authorization: { userId: user.id, courseId: course.id },
        lessonId: lesson.id,
        parentId: null,
        body: "One logical notification",
      },
      database
    );
    const delivery = database.select().from(notificationDeliveries).get()!;

    expect(() =>
      database
        .insert(notificationDeliveries)
        .values({
          ...delivery,
          id: undefined,
          idempotencyKey: `${delivery.idempotencyKey}:duplicate`,
        })
        .run()
    ).toThrow();
    expect(database.select().from(notificationDeliveries).all()).toHaveLength(
      1
    );
    expect(delivery.recipientId).toBe(instructor.id);
  });

  test("does not notify for a top-level post without a current Student Enrollment", () => {
    const database = createTestDb();
    const { user, instructor, course } = seedBaseData(database);
    const module = database
      .insert(modules)
      .values({ courseId: course.id, title: "M", position: 1 })
      .returning()
      .get();
    const lesson = database
      .insert(lessons)
      .values({ moduleId: module.id, title: "L", position: 1 })
      .returning()
      .get();

    createDiscussionPost(
      {
        authorization: { userId: user.id, courseId: course.id },
        lessonId: lesson.id,
        parentId: null,
        body: "No current enrollment",
      },
      database
    );
    createDiscussionPost(
      {
        authorization: { userId: instructor.id, courseId: course.id },
        lessonId: lesson.id,
        parentId: null,
        body: "Instructor top-level post",
      },
      database
    );

    expect(database.select().from(comments).all()).toHaveLength(2);
    expect(database.select().from(notificationEvents).all()).toEqual([]);
    expect(database.select().from(notificationDeliveries).all()).toEqual([]);
  });
  test("commits a Question and returns its Course context", () => {
    const database = createTestDb();
    const { user, course } = seedBaseData(database);
    const module = database
      .insert(modules)
      .values({ courseId: course.id, title: "Start here", position: 1 })
      .returning()
      .get();
    const lesson = database
      .insert(lessons)
      .values({ moduleId: module.id, title: "Welcome", position: 1 })
      .returning()
      .get();

    const result = createDiscussionPost(
      {
        authorization: { userId: user.id, courseId: course.id },
        lessonId: lesson.id,
        parentId: null,
        body: "  How does this work?  ",
      },
      database
    );

    expect(result).toEqual({
      source: expect.objectContaining({
        id: expect.any(Number),
        userId: user.id,
        lessonId: lesson.id,
        parentId: null,
        body: "How does this work?",
      }),
      course: {
        id: course.id,
        title: "Test Course",
        slug: "test-course",
        instructorId: course.instructorId,
      },
    });
    expect(database.select().from(comments).all()).toHaveLength(1);
  });

  test("rejects a Reply whose parent does not exist without writing", () => {
    const database = createTestDb();
    const { user, course } = seedBaseData(database);
    const module = database
      .insert(modules)
      .values({ courseId: course.id, title: "Start here", position: 1 })
      .returning()
      .get();
    const lesson = database
      .insert(lessons)
      .values({ moduleId: module.id, title: "Welcome", position: 1 })
      .returning()
      .get();

    expect(() =>
      createDiscussionPost(
        {
          authorization: { userId: user.id, courseId: course.id },
          lessonId: lesson.id,
          parentId: 999,
          body: "A reply",
        },
        database
      )
    ).toThrow("Parent comment not found");
    expect(database.select().from(comments).all()).toEqual([]);
  });

  test("rejects a Reply to a Question from another Lesson", () => {
    const database = createTestDb();
    const { user, course } = seedBaseData(database);
    const module = database
      .insert(modules)
      .values({ courseId: course.id, title: "Start here", position: 1 })
      .returning()
      .get();
    const [firstLesson, secondLesson] = database
      .insert(lessons)
      .values([
        { moduleId: module.id, title: "One", position: 1 },
        { moduleId: module.id, title: "Two", position: 2 },
      ])
      .returning()
      .all();
    const authorization = { userId: user.id, courseId: course.id };
    const question = createDiscussionPost(
      {
        authorization,
        lessonId: firstLesson.id,
        parentId: null,
        body: "Question",
      },
      database
    ).source;

    expect(() =>
      createDiscussionPost(
        {
          authorization,
          lessonId: secondLesson.id,
          parentId: question.id,
          body: "Reply",
        },
        database
      )
    ).toThrow("Parent comment belongs to a different lesson");
    expect(database.select().from(comments).all()).toEqual([question]);
  });

  test("rejects Replies to Replies", () => {
    const database = createTestDb();
    const { user, instructor, course } = seedBaseData(database);
    const module = database
      .insert(modules)
      .values({ courseId: course.id, title: "Start here", position: 1 })
      .returning()
      .get();
    const lesson = database
      .insert(lessons)
      .values({ moduleId: module.id, title: "Welcome", position: 1 })
      .returning()
      .get();
    const question = createDiscussionPost(
      {
        authorization: { userId: user.id, courseId: course.id },
        lessonId: lesson.id,
        parentId: null,
        body: "Question",
      },
      database
    ).source;
    const reply = createDiscussionPost(
      {
        authorization: { userId: instructor.id, courseId: course.id },
        lessonId: lesson.id,
        parentId: question.id,
        body: "Reply",
      },
      database
    ).source;

    expect(() =>
      createDiscussionPost(
        {
          authorization: { userId: user.id, courseId: course.id },
          lessonId: lesson.id,
          parentId: reply.id,
          body: "Nested reply",
        },
        database
      )
    ).toThrow("Replies can only be one level deep");
    expect(database.select().from(comments).all()).toHaveLength(2);
  });

  test("commits a Reply beneath its Question", () => {
    const database = createTestDb();
    const { user, instructor, course } = seedBaseData(database);
    const module = database
      .insert(modules)
      .values({ courseId: course.id, title: "Start here", position: 1 })
      .returning()
      .get();
    const lesson = database
      .insert(lessons)
      .values({ moduleId: module.id, title: "Welcome", position: 1 })
      .returning()
      .get();
    const question = createDiscussionPost(
      {
        authorization: { userId: user.id, courseId: course.id },
        lessonId: lesson.id,
        parentId: null,
        body: "Question",
      },
      database
    ).source;

    const result = createDiscussionPost(
      {
        authorization: { userId: instructor.id, courseId: course.id },
        lessonId: lesson.id,
        parentId: question.id,
        body: "  Answer  ",
      },
      database
    );

    expect(result.source).toEqual(
      expect.objectContaining({
        userId: instructor.id,
        lessonId: lesson.id,
        parentId: question.id,
        body: "Answer",
      })
    );
    expect(result.course.id).toBe(course.id);
    expect(database.select().from(comments).all()).toHaveLength(2);
  });

  test.each([
    ["empty", "   ", "Comment cannot be empty"],
    ["too long", "x".repeat(5001), "Comment must be 5000 characters or fewer"],
  ])("rejects an %s body without writing", (_case, body, message) => {
    const database = createTestDb();
    const { user, course } = seedBaseData(database);
    const module = database
      .insert(modules)
      .values({ courseId: course.id, title: "Start here", position: 1 })
      .returning()
      .get();
    const lesson = database
      .insert(lessons)
      .values({ moduleId: module.id, title: "Welcome", position: 1 })
      .returning()
      .get();

    expect(() =>
      createDiscussionPost(
        {
          authorization: { userId: user.id, courseId: course.id },
          lessonId: lesson.id,
          parentId: null,
          body,
        },
        database
      )
    ).toThrow(message);
    expect(database.select().from(comments).all()).toEqual([]);
  });

  test("rejects missing or wrongly scoped authorization without writing", () => {
    const database = createTestDb();
    const { user, course } = seedBaseData(database);
    const module = database
      .insert(modules)
      .values({ courseId: course.id, title: "Start here", position: 1 })
      .returning()
      .get();
    const lesson = database
      .insert(lessons)
      .values({ moduleId: module.id, title: "Welcome", position: 1 })
      .returning()
      .get();

    for (const authorization of [
      null,
      { userId: user.id, courseId: course.id + 100 },
    ]) {
      expect(() =>
        createDiscussionPost(
          {
            authorization,
            lessonId: lesson.id,
            parentId: null,
            body: "Question",
          },
          database
        )
      ).toThrow("Not authorized to post in this course");
    }
    expect(database.select().from(comments).all()).toEqual([]);
  });
});
