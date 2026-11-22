import { eq } from "drizzle-orm";
import { db } from "~/db";
import { comments, courses, lessons, modules } from "~/db/schema";
import { MAX_COMMENT_LENGTH, MIN_COMMENT_LENGTH } from "~/lib/comments";

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

export function createDiscussionPost(
  input: CreateDiscussionPostInput,
  database: DiscussionDatabase = db
) {
  return database.transaction((tx) => {
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

    if (input.parentId !== null) {
      const parent = tx
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

    return { source, course };
  });
}
