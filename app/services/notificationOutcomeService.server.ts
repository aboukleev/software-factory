import { createHmac, timingSafeEqual } from "node:crypto";
import { and, asc, eq, isNotNull, isNull, lte, or } from "drizzle-orm";
import { db } from "~/db";
import {
  notificationDeliveries,
  notificationDeliveryIncidents,
  notificationEvents,
  notificationOutcomeEvents,
} from "~/db/schema";
import { createNotificationOperations } from "~/services/notificationOperations.server";

export type DeliveryStatus = typeof notificationDeliveries.$inferSelect.status;

export const deliveryTransitions = {
  queued: ["attempting", "cancelled", "permanently_failed"],
  attempting: [
    "accepted",
    "retry_scheduled",
    "cancelled",
    "permanently_failed",
    "outcome_unknown",
  ],
  retry_scheduled: ["attempting", "cancelled", "permanently_failed"],
  accepted: ["delivered", "permanently_failed", "outcome_unknown"],
  delivered: [],
  cancelled: [],
  permanently_failed: ["queued"],
  outcome_unknown: ["delivered", "permanently_failed", "queued"],
} as const satisfies Record<DeliveryStatus, readonly DeliveryStatus[]>;

export type ProviderDeliveryOutcome = {
  kind:
    | "pending"
    | "delivered"
    | "skipped"
    | "permanently_failed"
    | "unknown"
    | "no_notification";
  messageIds?: string[];
  occurredAt?: string;
  evidence?: string;
};

type OutcomeProvider = {
  lookupOutcome?: (
    workflowRunId: string,
    idempotencyKey: string
  ) => Promise<ProviderDeliveryOutcome>;
};

type OutcomeDatabase = typeof db;

type OutcomeEvent = {
  providerEventId: string;
  workflowRunId: string;
  kind: Exclude<ProviderDeliveryOutcome["kind"], "pending" | "no_notification">;
  providerMessageIds?: string[];
  occurredAt: string;
};

const RECOVERY_WINDOW_MS = 24 * 60 * 60 * 1_000;
const RECONCILIATION_INTERVAL_MS = 60_000;

export function createNotificationOutcomeService({
  database = db,
  provider,
  now = () => new Date(),
}: {
  database?: OutcomeDatabase;
  provider: OutcomeProvider;
  now?: () => Date;
}) {
  const operations = createNotificationOperations({ database, now });
  function getDelivery(deliveryId: number) {
    const delivery = database
      .select()
      .from(notificationDeliveries)
      .where(eq(notificationDeliveries.id, deliveryId))
      .get();
    if (!delivery) throw new Error(`Delivery ${deliveryId} was not found`);
    return delivery;
  }

  function transition(
    deliveryId: number,
    nextStatus: DeliveryStatus,
    values: Partial<typeof notificationDeliveries.$inferInsert>
  ) {
    const current = getDelivery(deliveryId);
    const allowed = deliveryTransitions[
      current.status
    ] as readonly DeliveryStatus[];
    if (!allowed.includes(nextStatus)) {
      throw new Error(
        `Invalid Delivery transition ${current.status} -> ${nextStatus}`
      );
    }
    const changed = database
      .update(notificationDeliveries)
      .set({ ...values, status: nextStatus })
      .where(
        and(
          eq(notificationDeliveries.id, deliveryId),
          eq(notificationDeliveries.status, current.status)
        )
      )
      .returning({ status: notificationDeliveries.status })
      .get();
    if (changed) {
      operations.recordTransition(
        deliveryId,
        current.status,
        nextStatus,
        typeof values.errorCategory === "string"
          ? values.errorCategory
          : nextStatus
      );
    }
    return getDelivery(deliveryId);
  }

  function recordDuplicateIncident(
    deliveryId: number,
    providerEventId: string,
    messageIds: string[]
  ) {
    database
      .insert(notificationDeliveryIncidents)
      .values({
        deliveryId,
        providerEventId,
        kind: "physical_duplicate",
        evidence: JSON.stringify({
          messageIds: [...new Set(messageIds)].sort(),
        }),
      })
      .onConflictDoNothing()
      .run();
  }

  function applyOutcome(
    deliveryId: number,
    outcome: ProviderDeliveryOutcome,
    providerEventId: string
  ) {
    const delivery = getDelivery(deliveryId);
    const messageIds = [...new Set(outcome.messageIds ?? [])];
    const occurredAt = outcome.occurredAt ?? now().toISOString();
    if (messageIds.length > 1) {
      recordDuplicateIncident(deliveryId, providerEventId, messageIds);
      if (delivery.status === "accepted") {
        transition(deliveryId, "outcome_unknown", {
          errorCategory: "provider_physical_duplicate",
          outcomeCheckedAt: now().toISOString(),
          outcomeNextCheckAt: null,
        });
      }
      return;
    }
    if (outcome.kind === "delivered") {
      if (delivery.status === "delivered") {
        if (
          delivery.providerMessageId &&
          messageIds[0] &&
          delivery.providerMessageId !== messageIds[0]
        ) {
          recordDuplicateIncident(deliveryId, providerEventId, [
            delivery.providerMessageId,
            messageIds[0],
          ]);
        }
        return;
      }
      transition(deliveryId, "delivered", {
        deliveredAt: occurredAt,
        terminalAt: occurredAt,
        providerMessageId: messageIds[0] ?? null,
        errorCategory: null,
        outcomeCheckedAt: now().toISOString(),
        outcomeNextCheckAt: null,
      });
      return;
    }
    if (outcome.kind === "skipped") {
      if (
        delivery.status === "accepted" ||
        delivery.status === "outcome_unknown"
      ) {
        transition(deliveryId, "permanently_failed", {
          terminalAt: occurredAt,
          errorCategory: "provider_workflow_skipped",
          outcomeCheckedAt: now().toISOString(),
          outcomeNextCheckAt: null,
        });
      }
      return;
    }
    if (outcome.kind === "permanently_failed") {
      if (
        delivery.status === "accepted" ||
        delivery.status === "outcome_unknown"
      ) {
        transition(deliveryId, "permanently_failed", {
          terminalAt: occurredAt,
          errorCategory: "provider_outcome_permanent",
          outcomeCheckedAt: now().toISOString(),
          outcomeNextCheckAt: null,
        });
      }
      return;
    }
    if (outcome.kind === "unknown") {
      if (delivery.status === "accepted") {
        transition(deliveryId, "outcome_unknown", {
          errorCategory: "provider_outcome_ambiguous",
          outcomeCheckedAt: now().toISOString(),
          outcomeNextCheckAt: new Date(
            now().getTime() + RECONCILIATION_INTERVAL_MS
          ).toISOString(),
        });
      }
      return;
    }
    if (outcome.kind === "no_notification") {
      database
        .update(notificationDeliveries)
        .set({
          outcomeEvidence: outcome.evidence ?? "provider_confirmed_absent",
          outcomeCheckedAt: now().toISOString(),
        })
        .where(eq(notificationDeliveries.id, deliveryId))
        .run();
    }
  }

  function recordOutcome(event: OutcomeEvent) {
    const existing = database
      .select({ id: notificationOutcomeEvents.id })
      .from(notificationOutcomeEvents)
      .where(
        eq(notificationOutcomeEvents.providerEventId, event.providerEventId)
      )
      .get();
    if (existing)
      return { applied: false as const, reason: "duplicate_event" as const };

    const delivery = database
      .select({ id: notificationDeliveries.id })
      .from(notificationDeliveries)
      .where(
        eq(notificationDeliveries.providerWorkflowRunId, event.workflowRunId)
      )
      .get();
    if (!delivery)
      return { applied: false as const, reason: "unknown_delivery" as const };

    database.transaction((tx) => {
      tx.insert(notificationOutcomeEvents)
        .values({
          deliveryId: delivery.id,
          providerEventId: event.providerEventId,
          kind: event.kind,
          providerMessageIds: event.providerMessageIds
            ? JSON.stringify(event.providerMessageIds)
            : null,
          occurredAt: event.occurredAt,
        })
        .run();
      applyOutcome(
        delivery.id,
        {
          kind: event.kind,
          messageIds: event.providerMessageIds,
          occurredAt: event.occurredAt,
        },
        event.providerEventId
      );
    });
    return { applied: true as const };
  }

  async function reconcileAccepted(limit = 50) {
    if (!provider.lookupOutcome) return 0;
    const nowIso = now().toISOString();
    const candidates = database
      .select({
        id: notificationDeliveries.id,
        workflowRunId: notificationDeliveries.providerWorkflowRunId,
        idempotencyKey: notificationDeliveries.idempotencyKey,
      })
      .from(notificationDeliveries)
      .where(
        or(
          and(
            eq(notificationDeliveries.status, "accepted"),
            or(
              isNull(notificationDeliveries.outcomeNextCheckAt),
              lte(notificationDeliveries.outcomeNextCheckAt, nowIso)
            )
          ),
          and(
            eq(notificationDeliveries.status, "outcome_unknown"),
            isNotNull(notificationDeliveries.outcomeNextCheckAt),
            lte(notificationDeliveries.outcomeNextCheckAt, nowIso)
          )
        )
      )
      .orderBy(
        asc(notificationDeliveries.acceptedAt),
        asc(notificationDeliveries.id)
      )
      .limit(limit)
      .all();

    for (const candidate of candidates) {
      if (!candidate.workflowRunId) {
        applyOutcome(
          candidate.id,
          { kind: "unknown" },
          `reconcile:${candidate.id}:${nowIso}`
        );
        continue;
      }
      try {
        const outcome = await provider.lookupOutcome(
          candidate.workflowRunId,
          candidate.idempotencyKey
        );
        if (outcome.kind === "pending") {
          database
            .update(notificationDeliveries)
            .set({
              outcomeCheckedAt: nowIso,
              outcomeNextCheckAt: new Date(
                now().getTime() + RECONCILIATION_INTERVAL_MS
              ).toISOString(),
            })
            .where(eq(notificationDeliveries.id, candidate.id))
            .run();
        } else {
          applyOutcome(
            candidate.id,
            outcome,
            `reconcile:${candidate.id}:${nowIso}`
          );
        }
      } catch {
        database
          .update(notificationDeliveries)
          .set({
            outcomeCheckedAt: nowIso,
            outcomeNextCheckAt: new Date(
              now().getTime() + RECONCILIATION_INTERVAL_MS
            ).toISOString(),
          })
          .where(eq(notificationDeliveries.id, candidate.id))
          .run();
      }
    }
    return candidates.length;
  }

  function startPeriodicReconciliation(
    intervalMs = RECONCILIATION_INTERVAL_MS
  ) {
    let reconciliation: Promise<number> | undefined;
    const timer = setInterval(() => {
      if (reconciliation) return;
      reconciliation = reconcileAccepted().finally(() => {
        reconciliation = undefined;
      });
      void reconciliation.catch(() => undefined);
    }, intervalMs);
    if (typeof timer === "object" && "unref" in timer) timer.unref();
    return async () => {
      clearInterval(timer);
      await reconciliation;
    };
  }

  function confirmNoNotification(deliveryId: number, evidence: string) {
    const delivery = getDelivery(deliveryId);
    if (delivery.status !== "outcome_unknown") {
      throw new Error(
        "No-Notification evidence applies only to unresolved Delivery"
      );
    }
    if (!evidence.trim()) throw new Error("provider evidence is required");
    database
      .update(notificationDeliveries)
      .set({
        outcomeEvidence: evidence.trim(),
        outcomeCheckedAt: now().toISOString(),
      })
      .where(eq(notificationDeliveries.id, deliveryId))
      .run();
  }

  function requeue(deliveryId: number) {
    const delivery = getDelivery(deliveryId);
    const event = database
      .select({ occurredAt: notificationEvents.occurredAt })
      .from(notificationEvents)
      .where(eq(notificationEvents.id, delivery.notificationEventId))
      .get();
    if (
      !event ||
      now().getTime() >= Date.parse(event.occurredAt) + RECOVERY_WINDOW_MS
    ) {
      throw new Error("24-hour recovery window has expired");
    }
    if (delivery.status === "outcome_unknown" && !delivery.outcomeEvidence) {
      throw new Error("provider evidence of no Notification is required");
    }
    if (
      delivery.status !== "outcome_unknown" &&
      delivery.status !== "permanently_failed"
    ) {
      throw new Error(
        `Delivery in ${delivery.status} cannot be manually requeued`
      );
    }
    return transition(deliveryId, "queued", {
      nextAttemptAt: now().toISOString(),
      terminalAt: null,
      errorCategory: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      outcomeNextCheckAt: null,
    });
  }

  return {
    transition,
    recordOutcome,
    reconcileAccepted,
    startPeriodicReconciliation,
    confirmNoNotification,
    requeue,
  };
}

export function verifyKnockWebhookSignature(
  body: string,
  signatureHeader: string | null,
  secret: string,
  now = new Date()
) {
  if (!signatureHeader || !secret) return false;
  const parts = Object.fromEntries(
    signatureHeader.split(",").map((part) => {
      const separator = part.indexOf("=");
      return separator < 0
        ? [part, ""]
        : [part.slice(0, separator), part.slice(separator + 1)];
    })
  );
  const timestamp = parts.t;
  const supplied = parts.s;
  if (!timestamp || !supplied) return false;
  const timestampMs = Number(timestamp);
  if (
    !Number.isFinite(timestampMs) ||
    Math.abs(now.getTime() - timestampMs) > 5 * 60_000
  ) {
    return false;
  }
  const expected = createHmac("sha256", secret)
    .update(`${timestamp}.${body}`)
    .digest("base64");
  const expectedBuffer = Buffer.from(expected);
  const suppliedBuffer = Buffer.from(supplied);
  return (
    expectedBuffer.length === suppliedBuffer.length &&
    timingSafeEqual(expectedBuffer, suppliedBuffer)
  );
}
