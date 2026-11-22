import { describe, expect, test } from "vitest";
import { createDiscussionPost } from "~/services/discussionService";
import { createTestDb, seedBaseData } from "~/test/setup";
import { comments, lessons, modules } from "~/db/schema";

describe("createDiscussionPost", () => {
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
