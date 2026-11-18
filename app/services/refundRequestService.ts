import { and, eq, inArray } from "drizzle-orm";
import { db } from "~/db";
import {
  coupons,
  enrollments,
  purchases,
  refundRequests,
  RefundRequestStatus,
} from "~/db/schema";

export class RefundRequestNotFoundError extends Error {}
export class RefundRequestAlreadyResolvedError extends Error {}

export function isPurchaseRedemptionBlocked(
  database: typeof db,
  purchaseId: number
) {
  return Boolean(
    database
      .select({ id: refundRequests.id })
      .from(refundRequests)
      .where(
        and(
          eq(refundRequests.purchaseId, purchaseId),
          inArray(refundRequests.status, [
            RefundRequestStatus.Open,
            RefundRequestStatus.Approved,
          ])
        )
      )
      .get()
  );
}

export function processRefundRequest(
  database: typeof db,
  input: {
    refundRequestId: number;
    decision: RefundRequestStatus.Approved | RefundRequestStatus.Declined;
    resolutionNote: string;
    resolvedByUserId: number;
    resolvedAt?: string;
  }
) {
  return database.transaction((tx) => {
    const request = tx
      .select({
        id: refundRequests.id,
        status: refundRequests.status,
        purchaseId: purchases.id,
        purchaserId: purchases.userId,
        courseId: purchases.courseId,
      })
      .from(refundRequests)
      .innerJoin(purchases, eq(refundRequests.purchaseId, purchases.id))
      .where(eq(refundRequests.id, input.refundRequestId))
      .get();

    if (!request) {
      throw new RefundRequestNotFoundError("Refund Request not found.");
    }

    if (request.status !== RefundRequestStatus.Open) {
      throw new RefundRequestAlreadyResolvedError(
        "This Refund Request has already been resolved."
      );
    }

    const result = tx
      .update(refundRequests)
      .set({
        status: input.decision,
        resolutionNote: input.resolutionNote,
        resolvedByUserId: input.resolvedByUserId,
        resolvedAt: input.resolvedAt ?? new Date().toISOString(),
      })
      .where(
        and(
          eq(refundRequests.id, input.refundRequestId),
          eq(refundRequests.status, RefundRequestStatus.Open)
        )
      )
      .run();

    if (result.changes !== 1) {
      throw new RefundRequestAlreadyResolvedError(
        "This Refund Request has already been resolved."
      );
    }

    if (input.decision === RefundRequestStatus.Approved) {
      const teamSeat = tx
        .select({ id: coupons.id })
        .from(coupons)
        .where(eq(coupons.purchaseId, request.purchaseId))
        .get();

      if (!teamSeat) {
        tx.delete(enrollments)
          .where(
            and(
              eq(enrollments.userId, request.purchaserId),
              eq(enrollments.courseId, request.courseId)
            )
          )
          .run();
      }
    }

    return {
      refundRequestId: request.id,
      status: input.decision,
    };
  });
}
