import { data, redirect } from "react-router";
import { z } from "zod";
import type { Route } from "./+types/courses.$slug.refund";
import { getCurrentUserId } from "~/lib/session";
import { db } from "~/db";
import {
  courses,
  coupons,
  lessonProgress,
  lessons,
  modules,
  purchases,
  refundRequests,
  videoWatchEvents,
  LessonProgressStatus,
  RefundRequestStatus,
} from "~/db/schema";
import { and, eq, inArray, isNotNull, or, sql } from "drizzle-orm";
import { parseFormData, parseParams } from "~/lib/validation";

const REFUND_WINDOW_DAYS = 14;
const MAX_WATCHED_HOURS = 2;

const refundParamsSchema = z.object({
  slug: z.string().min(1),
});

const refundActionSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(10, "Tell us a little more about why you want a refund.")
    .max(1000, "Please keep your reason under 1000 characters."),
});

function getCourseBySlug(slug: string) {
  return db.select().from(courses).where(eq(courses.slug, slug)).get();
}

function getLatestPurchase(userId: number, courseId: number) {
  return db
    .select()
    .from(purchases)
    .where(and(eq(purchases.userId, userId), eq(purchases.courseId, courseId)))
    .orderBy(sql`${purchases.createdAt} desc`)
    .get();
}

function getLessonIdsForCourse(courseId: number): number[] {
  const rows = db
    .select({ id: lessons.id })
    .from(lessons)
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .where(eq(modules.courseId, courseId))
    .all();

  return rows.map((row) => row.id);
}

function getBlockingRefundRequest(purchaseId: number) {
  return db
    .select()
    .from(refundRequests)
    .where(
      and(
        eq(refundRequests.purchaseId, purchaseId),
        or(
          eq(refundRequests.status, RefundRequestStatus.Open),
          eq(refundRequests.status, RefundRequestStatus.Approved)
        )
      )
    )
    .get();
}

// The fourteen-day window is counted in whole days, not hours — someone who
// buys at 23:00 should still get the whole of their fourteenth day.
function calendarDay(when: Date): string {
  const month = String(when.getMonth() + 1).padStart(2, "0");
  const day = String(when.getDate()).padStart(2, "0");
  return `${when.getFullYear()}-${month}-${day}`;
}

function lastDayOfWindow(purchasedAtIso: string): string {
  const deadline = new Date(purchasedAtIso);
  deadline.setDate(deadline.getDate() + REFUND_WINDOW_DAYS);
  return calendarDay(deadline);
}

export async function action({ params, request }: Route.ActionArgs) {
  const currentUserId = await getCurrentUserId(request);

  if (!currentUserId) {
    throw data("You must be logged in to request a refund.", { status: 401 });
  }

  const parsed = parseFormData(await request.formData(), refundActionSchema);
  if (!parsed.success) {
    return data({ errors: parsed.errors }, { status: 400 });
  }

  const { slug } = parseParams(params, refundParamsSchema);
  const course = getCourseBySlug(slug);

  if (!course) {
    throw data("Course not found", { status: 404 });
  }

  const purchase = getLatestPurchase(currentUserId, course.id);

  if (!purchase) {
    throw data("You have not bought this course.", { status: 403 });
  }

  if (getBlockingRefundRequest(purchase.id)) {
    throw data(
      "This purchase already has an open or approved Refund Request.",
      {
        status: 409,
      }
    );
  }

  // A seat that came out of a team licence, and has been claimed, belongs to
  // the team — the learner cannot hand it back on their own.
  const redeemedSeatResult = db
    .select({ count: sql<number>`count(*)` })
    .from(coupons)
    .where(
      and(eq(coupons.purchaseId, purchase.id), isNotNull(coupons.redeemedAt))
    )
    .get();
  const redeemedSeatCount = redeemedSeatResult?.count ?? 0;

  if (redeemedSeatCount > 0) {
    throw data("A claimed team seat cannot be refunded.", { status: 403 });
  }

  const today = calendarDay(new Date());
  const purchasedDay = calendarDay(new Date(purchase.createdAt));
  const withinRefundWindow =
    today >= purchasedDay && today <= lastDayOfWindow(purchase.createdAt);

  if (!withinRefundWindow) {
    throw data(`The ${REFUND_WINDOW_DAYS}-day window has closed.`, {
      status: 403,
    });
  }

  const courseLessonIds = getLessonIdsForCourse(course.id);
  let completedLessons = 0;

  if (courseLessonIds.length > 0) {
    const completedResult = db
      .select({
        count: sql<number>`count(distinct ${lessonProgress.lessonId})`,
      })
      .from(lessonProgress)
      .where(
        and(
          eq(lessonProgress.userId, currentUserId),
          eq(lessonProgress.status, LessonProgressStatus.Completed),
          inArray(lessonProgress.lessonId, courseLessonIds)
        )
      )
      .get();

    completedLessons = completedResult?.count ?? 0;
    if (completedLessons / courseLessonIds.length >= 0.5) {
      throw data(
        "You have completed too much of this course to request a refund.",
        { status: 403 }
      );
    }
  }

  let watchedSeconds = 0;
  if (courseLessonIds.length > 0) {
    const furthestPerLesson = db
      .select({
        furthest: sql<number>`max(${videoWatchEvents.positionSeconds})`,
      })
      .from(videoWatchEvents)
      .where(
        and(
          eq(videoWatchEvents.userId, currentUserId),
          inArray(videoWatchEvents.lessonId, courseLessonIds)
        )
      )
      .groupBy(videoWatchEvents.lessonId)
      .all();

    watchedSeconds = furthestPerLesson.reduce(
      (total, row) => total + row.furthest,
      0
    );
  }

  if (watchedSeconds >= MAX_WATCHED_HOURS * 60 * 60) {
    throw data(
      "You have watched too much of this course to request a refund.",
      {
        status: 403,
      }
    );
  }

  try {
    db.insert(refundRequests)
      .values({
        purchaseId: purchase.id,
        status: RefundRequestStatus.Open,
        reason: parsed.data.reason,
        eligibilityCompletedLessons: completedLessons,
        eligibilityTotalLessons: courseLessonIds.length,
        eligibilityWatchedSeconds: watchedSeconds,
        eligibilityRedeemedSeats: redeemedSeatCount,
      })
      .returning()
      .get();
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "SQLITE_CONSTRAINT_UNIQUE"
    ) {
      throw data("This purchase already has an Open Refund Request.", {
        status: 409,
      });
    }
    throw error;
  }

  return redirect("/settings");
}
