import { beforeEach, describe, expect, test, vi } from "vitest";
import { db } from "~/db";
import {
  categories,
  comments,
  courses,
  lessons,
  modules,
  users,
} from "~/db/schema";
import { seedBaseData } from "~/test/setup";
import { action as lessonAction } from "./courses.$slug.lessons.$lessonId";
import { action as instructorQuestionsAction } from "./instructor.questions";

const accessMocks = vi.hoisted(() => ({
  getCurrentUserId: vi.fn(),
  requireContentAccess: vi.fn(),
  requireStaff: vi.fn(),
}));

vi.mock("~/db", async () => {
  const { createTestDb } = await import("~/test/setup");
  return { db: createTestDb() };
});

vi.mock("~/lib/session", () => ({
  getCurrentUserId: accessMocks.getCurrentUserId,
}));

vi.mock("~/lib/access.server", () => ({
  getAccess: vi.fn(),
  requireContentAccess: accessMocks.requireContentAccess,
  requireInstructorOrAdmin: vi.fn(),
  requireStaff: accessMocks.requireStaff,
}));

function request(path: string, body: URLSearchParams) {
  return new Request(`http://cadence.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
}

function seedLesson() {
  const base = seedBaseData(db);
  const module = db
    .insert(modules)
    .values({ courseId: base.course.id, title: "Start here", position: 1 })
    .returning()
    .get();
  const lesson = db
    .insert(lessons)
    .values({ moduleId: module.id, title: "Welcome", position: 1 })
    .returning()
    .get();
  return { ...base, lesson };
}

beforeEach(() => {
  db.delete(comments).run();
  db.delete(lessons).run();
  db.delete(modules).run();
  db.delete(courses).run();
  db.delete(categories).run();
  db.delete(users).run();
  vi.clearAllMocks();
});

describe("discussion route actions", () => {
  test("the Lesson discussion action creates a Question", async () => {
    const { user, course, lesson } = seedLesson();
    accessMocks.getCurrentUserId.mockResolvedValue(user.id);
    accessMocks.requireContentAccess.mockResolvedValue({
      userId: user.id,
      canViewContent: true,
    });

    const result = await lessonAction({
      params: { slug: course.slug, lessonId: String(lesson.id) },
      request: request(
        `/courses/${course.slug}/lessons/${lesson.id}`,
        new URLSearchParams({
          intent: "create-comment",
          body: "  A route Question  ",
        })
      ),
    } as never);

    expect(result).toEqual({ ok: true });
    expect(db.select().from(comments).all()).toEqual([
      expect.objectContaining({
        userId: user.id,
        lessonId: lesson.id,
        parentId: null,
        body: "A route Question",
      }),
    ]);
  });

  test("the unanswered Questions action creates a Reply", async () => {
    const { user, instructor, course, lesson } = seedLesson();
    const question = db
      .insert(comments)
      .values({ userId: user.id, lessonId: lesson.id, body: "Question" })
      .returning()
      .get();
    accessMocks.requireStaff.mockResolvedValue({ userId: instructor.id });

    const result = await instructorQuestionsAction({
      request: request(
        "/instructor/questions",
        new URLSearchParams({
          intent: "reply",
          commentId: String(question.id),
          body: "  A route Reply  ",
        })
      ),
    } as never);

    expect(result).toEqual({ ok: true });
    expect(db.select().from(comments).all()).toEqual([
      question,
      expect.objectContaining({
        userId: instructor.id,
        lessonId: lesson.id,
        parentId: question.id,
        body: "A route Reply",
      }),
    ]);
    expect(accessMocks.requireStaff).toHaveBeenCalledWith(
      expect.any(Request),
      course.id
    );
  });
});
