import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { createTestDb, seedBaseData } from "~/test/setup";
import {
  coupons,
  enrollments,
  lessonProgress,
  lessons,
  LessonProgressStatus,
  modules,
  purchases,
  refundRequests,
  RefundRequestStatus,
  teams,
  UserRole,
  users,
} from "~/db/schema";
import {
  isPurchaseRedemptionBlocked,
  processRefundRequest,
  RefundRequestAlreadyResolvedError,
} from "./refundRequestService";

function seedRefundRequest(options: { teamPurchase?: boolean } = {}) {
  const database = createTestDb();
  const { user, course } = seedBaseData(database);
  const admin = database
    .insert(users)
    .values({
      name: "Test Admin",
      email: "admin@example.com",
      role: UserRole.Admin,
    })
    .returning()
    .get();
  const purchase = database
    .insert(purchases)
    .values({
      userId: user.id,
      courseId: course.id,
      amountPaid: 7900,
    })
    .returning()
    .get();
  database
    .insert(enrollments)
    .values({ userId: user.id, courseId: course.id })
    .run();

  if (options.teamPurchase) {
    const team = database.insert(teams).values({}).returning().get();
    database
      .insert(coupons)
      .values({
        teamId: team.id,
        courseId: course.id,
        purchaseId: purchase.id,
        code: "TEAM-TEST",
      })
      .run();
  }

  const refundRequest = database
    .insert(refundRequests)
    .values({
      purchaseId: purchase.id,
      status: RefundRequestStatus.Open,
      reason: "I bought the wrong course by mistake.",
      eligibilityCompletedLessons: 1,
      eligibilityTotalLessons: 10,
      eligibilityWatchedSeconds: 300,
      eligibilityRedeemedSeats: 0,
    })
    .returning()
    .get();

  return { database, user, admin, course, purchase, refundRequest };
}

describe("processRefundRequest", () => {
  it("approves a direct-purchase request and removes access without deleting progress", () => {
    const { database, user, admin, course, refundRequest } =
      seedRefundRequest();
    const courseModule = database
      .insert(modules)
      .values({ courseId: course.id, title: "Module", position: 1 })
      .returning()
      .get();
    const lesson = database
      .insert(lessons)
      .values({ moduleId: courseModule.id, title: "Lesson", position: 1 })
      .returning()
      .get();
    database
      .insert(lessonProgress)
      .values({
        userId: user.id,
        lessonId: lesson.id,
        status: LessonProgressStatus.Completed,
      })
      .run();

    processRefundRequest(database, {
      refundRequestId: refundRequest.id,
      decision: RefundRequestStatus.Approved,
      resolutionNote: "Eligible request approved.",
      resolvedByUserId: admin.id,
      resolvedAt: "2026-11-18T12:00:00.000Z",
    });

    expect(
      database
        .select()
        .from(enrollments)
        .where(
          and(
            eq(enrollments.userId, user.id),
            eq(enrollments.courseId, course.id)
          )
        )
        .get()
    ).toBeUndefined();
    expect(database.select().from(lessonProgress).all()).toHaveLength(1);
    expect(
      database
        .select()
        .from(refundRequests)
        .where(eq(refundRequests.id, refundRequest.id))
        .get()
    ).toMatchObject({
      status: RefundRequestStatus.Approved,
      resolutionNote: "Eligible request approved.",
      resolvedByUserId: admin.id,
      resolvedAt: "2026-11-18T12:00:00.000Z",
      amountRefunded: null,
    });
  });

  it("declines a request without removing enrollment", () => {
    const { database, user, admin, course, refundRequest } =
      seedRefundRequest();

    processRefundRequest(database, {
      refundRequestId: refundRequest.id,
      decision: RefundRequestStatus.Declined,
      resolutionNote: "The request does not qualify.",
      resolvedByUserId: admin.id,
    });

    expect(
      database
        .select()
        .from(enrollments)
        .where(
          and(
            eq(enrollments.userId, user.id),
            eq(enrollments.courseId, course.id)
          )
        )
        .get()
    ).toBeDefined();
  });

  it("keeps the purchaser's independent enrollment for a team purchase", () => {
    const { database, user, admin, course, refundRequest } = seedRefundRequest({
      teamPurchase: true,
    });

    processRefundRequest(database, {
      refundRequestId: refundRequest.id,
      decision: RefundRequestStatus.Approved,
      resolutionNote: "Unused team purchase approved.",
      resolvedByUserId: admin.id,
    });

    expect(
      database
        .select()
        .from(enrollments)
        .where(
          and(
            eq(enrollments.userId, user.id),
            eq(enrollments.courseId, course.id)
          )
        )
        .get()
    ).toBeDefined();
  });

  it("blocks team-seat redemption while open or approved, but not after decline", () => {
    const open = seedRefundRequest({ teamPurchase: true });
    expect(isPurchaseRedemptionBlocked(open.database, open.purchase.id)).toBe(
      true
    );

    processRefundRequest(open.database, {
      refundRequestId: open.refundRequest.id,
      decision: RefundRequestStatus.Approved,
      resolutionNote: "Approved team refund.",
      resolvedByUserId: open.admin.id,
    });
    expect(isPurchaseRedemptionBlocked(open.database, open.purchase.id)).toBe(
      true
    );

    const declined = seedRefundRequest({ teamPurchase: true });
    processRefundRequest(declined.database, {
      refundRequestId: declined.refundRequest.id,
      decision: RefundRequestStatus.Declined,
      resolutionNote: "Declined team refund.",
      resolvedByUserId: declined.admin.id,
    });
    expect(
      isPurchaseRedemptionBlocked(declined.database, declined.purchase.id)
    ).toBe(false);
  });

  it("allows only the first resolution", () => {
    const { database, admin, refundRequest } = seedRefundRequest();

    processRefundRequest(database, {
      refundRequestId: refundRequest.id,
      decision: RefundRequestStatus.Declined,
      resolutionNote: "First decision.",
      resolvedByUserId: admin.id,
    });

    expect(() =>
      processRefundRequest(database, {
        refundRequestId: refundRequest.id,
        decision: RefundRequestStatus.Approved,
        resolutionNote: "Second decision.",
        resolvedByUserId: admin.id,
      })
    ).toThrow(RefundRequestAlreadyResolvedError);
  });

  it("still approves when the enrollment is already missing", () => {
    const { database, user, admin, course, refundRequest } =
      seedRefundRequest();
    database
      .delete(enrollments)
      .where(
        and(
          eq(enrollments.userId, user.id),
          eq(enrollments.courseId, course.id)
        )
      )
      .run();

    expect(() =>
      processRefundRequest(database, {
        refundRequestId: refundRequest.id,
        decision: RefundRequestStatus.Approved,
        resolutionNote: "Access was already absent.",
        resolvedByUserId: admin.id,
      })
    ).not.toThrow();
  });

  it("enforces at most one open request for a purchase", () => {
    const { database, purchase } = seedRefundRequest();

    expect(() =>
      database
        .insert(refundRequests)
        .values({
          purchaseId: purchase.id,
          status: RefundRequestStatus.Open,
          reason: "A simultaneous duplicate request.",
        })
        .run()
    ).toThrow();
  });
});
