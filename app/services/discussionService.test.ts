import { describe, expect, test, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createDiscussionPost } from "~/services/discussionService";
import { createTestDb, seedBaseData } from "~/test/setup";
import {
  comments,
  courses,
  enrollments,
  lessons,
  modules,
  notificationDeliveries,
  notificationEvents,
  notificationOperationControls,
  UserRole,
  users,
} from "~/db/schema";
import { FakeKnockAdapter } from "~/services/notificationProvider";
import { createNotificationDispatcher } from "~/services/notificationDispatcher.server";

async function dispatchQueued(
  database: ReturnType<typeof createTestDb>,
  provider: FakeKnockAdapter
) {
  await createNotificationDispatcher({ database, provider }).runOnce();
}

describe("createDiscussionPost", () => {
  test("commits discussion content without creating Notification work while creation is paused", () => {
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
    database
      .insert(notificationOperationControls)
      .values({
        id: 1,
        creationEnabled: false,
        dispatchEnabled: true,
        feedEnabled: true,
        updatedAt: "2026-11-26T12:00:00.000Z",
      })
      .run();

    const result = createDiscussionPost(
      {
        authorization: { userId: user.id, courseId: course.id },
        lessonId: lesson.id,
        parentId: null,
        body: "Still committed",
      },
      database,
      vi.fn()
    );

    expect(result.source.body).toBe("Still committed");
    expect(database.select().from(notificationEvents).all()).toEqual([]);
    expect(database.select().from(notificationDeliveries).all()).toEqual([]);
  });

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
    const wake = vi.fn();

    const result = createDiscussionPost(
      {
        authorization: { userId: user.id, courseId: course.id },
        lessonId: lesson.id,
        parentId: null,
        body: "How does this work?",
      },
      database,
      wake
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
      eventKind: "question.created",
      occurredAt: result.source.createdAt,
      sourceCommentId: result.source.id,
      rootQuestionId: result.source.id,
      recipientId: instructor.id,
      courseId: course.id,
      lessonId: lesson.id,
    });
    expect(delivery.providerPayload).not.toContain("How does this work?");
    expect(delivery.providerPayload).not.toContain(user.name);
    expect(provider.list(instructor.id)).toEqual([]);
    expect(wake).toHaveBeenCalledOnce();

    await dispatchQueued(database, provider);
    expect(provider.list(instructor.id)).toEqual([
      expect.objectContaining({
        idempotencyKey: delivery.idempotencyKey,
        readAt: null,
      }),
    ]);
  });

  test("notifies the Student when the owning Instructor replies to a qualifying Question", async () => {
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
    const provider = new FakeKnockAdapter();
    const question = createDiscussionPost(
      {
        authorization: { userId: user.id, courseId: course.id },
        lessonId: lesson.id,
        parentId: null,
        body: "Question",
      },
      database,
      () => undefined
    ).source;

    const reply = createDiscussionPost(
      {
        authorization: { userId: instructor.id, courseId: course.id },
        lessonId: lesson.id,
        parentId: question.id,
        body: "Answer",
      },
      database,
      () => undefined
    ).source;

    const event = database
      .select()
      .from(notificationEvents)
      .all()
      .find((candidate) => candidate.sourceCommentId === reply.id);
    expect(event).toEqual({
      id: expect.any(Number),
      identity: `staff-reply.created:${reply.id}`,
      kind: "staff-reply.created",
      occurredAt: reply.createdAt,
      sourceCommentId: reply.id,
      rootQuestionId: question.id,
      actorId: instructor.id,
      actorCapacity: "instructor",
      recipientId: user.id,
      courseId: course.id,
      lessonId: lesson.id,
    });
    expect(database.select().from(notificationDeliveries).all()).toContainEqual(
      expect.objectContaining({
        notificationEventId: event!.id,
        recipientId: user.id,
        workflowKey: "staff-reply-created",
        idempotencyKey: `staff-reply.created:${reply.id}:${user.id}:in_app`,
        status: "queued",
      })
    );

    await dispatchQueued(database, provider);
    expect(provider.list(user.id)).toContainEqual(
      expect.objectContaining({
        eventIdentity: `staff-reply.created:${reply.id}`,
        sourceCommentId: reply.id,
        rootQuestionId: question.id,
      })
    );
  });

  test("captures Platform Admin capacity for a qualifying Reply", async () => {
    const database = createTestDb();
    const { user, course } = seedBaseData(database);
    const admin = database
      .insert(users)
      .values({
        name: "Platform Admin",
        email: "admin@example.com",
        role: UserRole.Admin,
      })
      .returning()
      .get();
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
        authorization: { userId: admin.id, courseId: course.id },
        lessonId: lesson.id,
        parentId: question.id,
        body: "Platform answer",
      },
      database
    ).source;

    expect(
      database
        .select()
        .from(notificationEvents)
        .all()
        .find((event) => event.sourceCommentId === reply.id)
    ).toEqual(
      expect.objectContaining({
        identity: `staff-reply.created:${reply.id}`,
        actorId: admin.id,
        actorCapacity: "platform_admin",
        recipientId: user.id,
        rootQuestionId: question.id,
      })
    );
  });

  test("does not notify for non-qualifying Reply actors or staff top-level posts", () => {
    const database = createTestDb();
    const { user, instructor, course } = seedBaseData(database);
    const otherStudent = database
      .insert(users)
      .values({
        name: "Other Student",
        email: "other-student@example.com",
        role: UserRole.Student,
      })
      .returning()
      .get();
    const otherInstructor = database
      .insert(users)
      .values({
        name: "Other Instructor",
        email: "other-instructor@example.com",
        role: UserRole.Instructor,
      })
      .returning()
      .get();
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
    const question = createDiscussionPost(
      {
        authorization: { userId: user.id, courseId: course.id },
        lessonId: lesson.id,
        parentId: null,
        body: "Question",
      },
      database
    ).source;
    const baselineEvents = database.select().from(notificationEvents).all();
    const baselineDeliveries = database
      .select()
      .from(notificationDeliveries)
      .all();

    for (const [actorId, parentId, body] of [
      [otherStudent.id, question.id, "Student Reply"],
      [otherInstructor.id, question.id, "Non-owning Instructor Reply"],
      [instructor.id, null, "Instructor contribution"],
    ] as const) {
      createDiscussionPost(
        {
          authorization: { userId: actorId, courseId: course.id },
          lessonId: lesson.id,
          parentId,
          body,
        },
        database
      );
    }

    expect(database.select().from(notificationEvents).all()).toEqual(
      baselineEvents
    );
    expect(database.select().from(notificationDeliveries).all()).toEqual(
      baselineDeliveries
    );
  });

  test("does not notify for a Reply to a pre-launch Question", () => {
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
    const historicalQuestion = database
      .insert(comments)
      .values({ userId: user.id, lessonId: lesson.id, body: "Old Question" })
      .returning()
      .get();

    createDiscussionPost(
      {
        authorization: { userId: instructor.id, courseId: course.id },
        lessonId: lesson.id,
        parentId: historicalQuestion.id,
        body: "New answer",
      },
      database
    );

    expect(database.select().from(notificationEvents).all()).toEqual([]);
    expect(database.select().from(notificationDeliveries).all()).toEqual([]);
  });

  test("retains a self-notification Event while suppressing Delivery", () => {
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
    const question = createDiscussionPost(
      {
        authorization: { userId: user.id, courseId: course.id },
        lessonId: lesson.id,
        parentId: null,
        body: "Question",
      },
      database
    ).source;
    database
      .update(users)
      .set({ role: UserRole.Admin })
      .where(eq(users.id, user.id))
      .run();
    const deliveriesBefore = database
      .select()
      .from(notificationDeliveries)
      .all();

    const reply = createDiscussionPost(
      {
        authorization: { userId: user.id, courseId: course.id },
        lessonId: lesson.id,
        parentId: question.id,
        body: "My own answer",
      },
      database
    ).source;

    expect(database.select().from(notificationEvents).all()).toContainEqual(
      expect.objectContaining({
        identity: `staff-reply.created:${reply.id}`,
        actorCapacity: "platform_admin",
        actorId: user.id,
        recipientId: user.id,
      })
    );
    expect(database.select().from(notificationDeliveries).all()).toEqual(
      deliveriesBefore
    );
  });

  test("keeps separately committed identical Replies as separate Events", () => {
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
    const question = createDiscussionPost(
      {
        authorization: { userId: user.id, courseId: course.id },
        lessonId: lesson.id,
        parentId: null,
        body: "Question",
      },
      database
    ).source;

    const replies = ["Same answer", "Same answer"].map(
      (body) =>
        createDiscussionPost(
          {
            authorization: { userId: instructor.id, courseId: course.id },
            lessonId: lesson.id,
            parentId: question.id,
            body,
          },
          database
        ).source
    );

    const replyEvents = database
      .select()
      .from(notificationEvents)
      .all()
      .filter((event) => event.kind === "staff-reply.created");
    expect(replyEvents.map((event) => event.identity)).toEqual([
      `staff-reply.created:${replies[0].id}`,
      `staff-reply.created:${replies[1].id}`,
    ]);
    expect(database.select().from(notificationDeliveries).all()).toHaveLength(
      3
    );
  });

  test("captures immutable Reply routing facts at commit time", () => {
    const database = createTestDb();
    const { user, instructor, course } = seedBaseData(database);
    const replacement = database
      .insert(users)
      .values({
        name: "Replacement Instructor",
        email: "replacement@example.com",
        role: UserRole.Instructor,
      })
      .returning()
      .get();
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
        body: "Answer",
      },
      database
    ).source;
    const captured = database
      .select()
      .from(notificationEvents)
      .all()
      .find((event) => event.sourceCommentId === reply.id)!;

    database.delete(enrollments).where(eq(enrollments.userId, user.id)).run();
    database
      .update(users)
      .set({ role: UserRole.Student })
      .where(eq(users.id, instructor.id))
      .run();
    database
      .update(courses)
      .set({ instructorId: replacement.id })
      .where(eq(courses.id, course.id))
      .run();

    expect(
      database
        .select()
        .from(notificationEvents)
        .all()
        .find((event) => event.id === captured.id)
    ).toEqual(captured);
    expect(captured).toEqual(
      expect.objectContaining({
        actorId: instructor.id,
        actorCapacity: "instructor",
        recipientId: user.id,
        courseId: course.id,
        lessonId: lesson.id,
        rootQuestionId: question.id,
        sourceCommentId: reply.id,
      })
    );
  });

  test("rolls back a qualifying Reply and its Event when Delivery persistence fails", () => {
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
    const question = createDiscussionPost(
      {
        authorization: { userId: user.id, courseId: course.id },
        lessonId: lesson.id,
        parentId: null,
        body: "Question",
      },
      database
    ).source;
    const before = {
      comments: database.select().from(comments).all(),
      events: database.select().from(notificationEvents).all(),
      deliveries: database.select().from(notificationDeliveries).all(),
    };

    expect(() =>
      createDiscussionPost(
        {
          authorization: { userId: instructor.id, courseId: course.id },
          lessonId: lesson.id,
          parentId: question.id,
          body: "   ",
        },
        database
      )
    ).toThrow("Comment cannot be empty");
    expect(database.select().from(comments).all()).toEqual(before.comments);
    expect(database.select().from(notificationEvents).all()).toEqual(
      before.events
    );
    expect(database.select().from(notificationDeliveries).all()).toEqual(
      before.deliveries
    );

    database.$client.exec(`
      CREATE TRIGGER reject_reply_delivery
      BEFORE INSERT ON notification_deliveries
      WHEN NEW.workflow_key = 'staff-reply-created'
      BEGIN SELECT RAISE(ABORT, 'simulated reply delivery failure'); END;
    `);

    expect(() =>
      createDiscussionPost(
        {
          authorization: { userId: instructor.id, courseId: course.id },
          lessonId: lesson.id,
          parentId: question.id,
          body: "Rolled back answer",
        },
        database
      )
    ).toThrow("simulated reply delivery failure");
    expect(database.select().from(comments).all()).toEqual(before.comments);
    expect(database.select().from(notificationEvents).all()).toEqual(
      before.events
    );
    expect(database.select().from(notificationDeliveries).all()).toEqual(
      before.deliveries
    );
  });

  test("edits, deletions, retries, and duplicate provider processing create nothing new", async () => {
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
    const provider = new FakeKnockAdapter();
    const question = createDiscussionPost(
      {
        authorization: { userId: user.id, courseId: course.id },
        lessonId: lesson.id,
        parentId: null,
        body: "Question",
      },
      database,
      () => undefined
    ).source;
    const reply = createDiscussionPost(
      {
        authorization: { userId: instructor.id, courseId: course.id },
        lessonId: lesson.id,
        parentId: question.id,
        body: "Answer",
      },
      database,
      () => undefined
    ).source;
    await provider.settled();
    const before = {
      events: database.select().from(notificationEvents).all(),
      deliveries: database.select().from(notificationDeliveries).all(),
    };
    const replyDelivery = before.deliveries.find(
      (delivery) =>
        delivery.workflowKey === "staff-reply-created" &&
        delivery.recipientId === user.id
    )!;
    const payload = JSON.parse(replyDelivery.providerPayload);

    database
      .update(comments)
      .set({ body: "Edited answer", editedAt: "2026-11-23T12:00:00.000Z" })
      .where(eq(comments.id, reply.id))
      .run();
    database
      .update(comments)
      .set({ deletedAt: "2026-11-23T12:01:00.000Z" })
      .where(eq(comments.id, reply.id))
      .run();
    provider.trigger(replyDelivery.idempotencyKey, payload);
    provider.trigger(replyDelivery.idempotencyKey, payload);

    expect(database.select().from(notificationEvents).all()).toEqual(
      before.events
    );
    expect(database.select().from(notificationDeliveries).all()).toEqual(
      before.deliveries
    );
    expect(provider.list(user.id)).toHaveLength(1);
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
        () => undefined
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
