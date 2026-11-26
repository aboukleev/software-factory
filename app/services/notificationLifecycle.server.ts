import { and, eq, inArray, isNotNull, lte } from "drizzle-orm";
import { db } from "~/db";
import {
  notificationDeliveries,
  notificationDeliveryIncidents,
  notificationEvents,
  notificationOutcomeEvents,
} from "~/db/schema";
import {
  UnsupportedProviderOperationError,
  type NotificationProvider,
} from "~/services/notificationProvider";

const VISIBLE_LIFETIME_MS = 90 * 24 * 60 * 60 * 1_000;
const LIFECYCLE_INTERVAL_MS = 60 * 60 * 1_000;
const LOCALLY_CLEANABLE_TERMINAL_STATUSES = [
  "cancelled",
  "permanently_failed",
] as const;
const PROVIDER_VISIBLE_STATUSES = [
  "accepted",
  "delivered",
  "outcome_unknown",
] as const;

type LifecycleDatabase = typeof db;
type LifecycleProvider = Pick<
  NotificationProvider,
  "permanentlyDeleteNotification" | "archiveNotification" | "deleteUser"
>;

export function createNotificationLifecycleService({
  database = db,
  provider,
  now = () => new Date(),
}: {
  database?: LifecycleDatabase;
  provider: LifecycleProvider;
  now?: () => Date;
}) {
  function deleteDeliveryAndOrphanedEvent(deliveryId: number, eventId: number) {
    database.transaction((tx) => {
      tx.delete(notificationOutcomeEvents)
        .where(eq(notificationOutcomeEvents.deliveryId, deliveryId))
        .run();
      tx.delete(notificationDeliveryIncidents)
        .where(eq(notificationDeliveryIncidents.deliveryId, deliveryId))
        .run();
      tx.delete(notificationDeliveries)
        .where(eq(notificationDeliveries.id, deliveryId))
        .run();
      const remaining = tx
        .select({ id: notificationDeliveries.id })
        .from(notificationDeliveries)
        .where(eq(notificationDeliveries.notificationEventId, eventId))
        .get();
      if (!remaining) {
        tx.delete(notificationEvents)
          .where(eq(notificationEvents.id, eventId))
          .run();
      }
    });
  }

  function recordIncident(
    deliveryId: number,
    providerEventId: string,
    kind: "privacy" | "reliability",
    evidence: string
  ) {
    database
      .insert(notificationDeliveryIncidents)
      .values({ deliveryId, providerEventId, kind, evidence })
      .onConflictDoNothing()
      .run();
  }

  async function expireNotifications() {
    const cutoff = new Date(
      now().getTime() - VISIBLE_LIFETIME_MS
    ).toISOString();
    const candidates = database
      .select({
        eventId: notificationEvents.id,
        deliveryId: notificationDeliveries.id,
        recipientId: notificationDeliveries.recipientId,
        idempotencyKey: notificationDeliveries.idempotencyKey,
        providerMessageId: notificationDeliveries.providerMessageId,
      })
      .from(notificationEvents)
      .innerJoin(
        notificationDeliveries,
        eq(notificationDeliveries.notificationEventId, notificationEvents.id)
      )
      .where(
        and(
          lte(notificationEvents.occurredAt, cutoff),
          inArray(notificationDeliveries.status, [...PROVIDER_VISIBLE_STATUSES])
        )
      )
      .all();
    let expired = 0;
    let blocked = 0;
    for (const candidate of candidates) {
      try {
        if (!provider.permanentlyDeleteNotification) {
          throw new UnsupportedProviderOperationError(
            "per-message permanent deletion"
          );
        }
        await provider.permanentlyDeleteNotification({
          messageId: candidate.providerMessageId,
          idempotencyKey: candidate.idempotencyKey,
          recipientId: candidate.recipientId,
        });
        deleteDeliveryAndOrphanedEvent(candidate.deliveryId, candidate.eventId);
        expired += 1;
      } catch (error) {
        blocked += 1;
        recordIncident(
          candidate.deliveryId,
          `retention-erasure-blocked:${candidate.deliveryId}`,
          "privacy",
          JSON.stringify({
            operation: "per_message_permanent_deletion",
            outcome:
              error instanceof UnsupportedProviderOperationError
                ? "unsupported"
                : "failed",
            archiveIsDeletion: false,
            releaseBlocked: true,
          })
        );
      }
    }
    return { expired, blocked };
  }

  function cleanupTerminalRecords() {
    const cutoff = new Date(
      now().getTime() - VISIBLE_LIFETIME_MS
    ).toISOString();
    const candidates = database
      .select({
        id: notificationDeliveries.id,
        eventId: notificationDeliveries.notificationEventId,
      })
      .from(notificationDeliveries)
      .where(
        and(
          inArray(notificationDeliveries.status, [
            ...LOCALLY_CLEANABLE_TERMINAL_STATUSES,
          ]),
          isNotNull(notificationDeliveries.terminalAt),
          lte(notificationDeliveries.terminalAt, cutoff)
        )
      )
      .all();
    for (const candidate of candidates) {
      deleteDeliveryAndOrphanedEvent(candidate.id, candidate.eventId);
    }
    return candidates.length;
  }

  async function eraseAccount(userId: number) {
    if (!provider.deleteUser) {
      throw new UnsupportedProviderOperationError("Knock User hard deletion");
    }
    await provider.deleteUser(userId);
    database.transaction((tx) => {
      const recipientEvents = tx
        .select({ id: notificationEvents.id })
        .from(notificationEvents)
        .where(eq(notificationEvents.recipientId, userId))
        .all();
      const eventIds = recipientEvents.map((event) => event.id);
      if (eventIds.length > 0) {
        const deliveries = tx
          .select({ id: notificationDeliveries.id })
          .from(notificationDeliveries)
          .where(inArray(notificationDeliveries.notificationEventId, eventIds))
          .all();
        const deliveryIds = deliveries.map((delivery) => delivery.id);
        if (deliveryIds.length > 0) {
          tx.delete(notificationOutcomeEvents)
            .where(inArray(notificationOutcomeEvents.deliveryId, deliveryIds))
            .run();
          tx.delete(notificationDeliveryIncidents)
            .where(
              inArray(notificationDeliveryIncidents.deliveryId, deliveryIds)
            )
            .run();
          tx.delete(notificationDeliveries)
            .where(inArray(notificationDeliveries.id, deliveryIds))
            .run();
        }
        tx.delete(notificationEvents)
          .where(inArray(notificationEvents.id, eventIds))
          .run();
      }

      // Actor identity is not sent to Knock. Preserve the content-free Event
      // and Delivery so the recipient's item remains eligible for normal
      // expiry, but remove the erased account's local identifier.
      tx.update(notificationEvents)
        .set({ actorId: null })
        .where(eq(notificationEvents.actorId, userId))
        .run();
    });
  }

  async function containIncorrectNotification(input: {
    deliveryId: number;
    messageId: string;
    classification: "privacy" | "reliability";
    evidence: string;
  }) {
    if (!provider.archiveNotification) {
      throw new UnsupportedProviderOperationError(
        "message archive containment"
      );
    }
    try {
      await provider.archiveNotification(input.messageId);
    } catch (error) {
      recordIncident(
        input.deliveryId,
        `containment-failed:${input.deliveryId}:${input.messageId}`,
        input.classification,
        JSON.stringify({
          reason: input.evidence,
          containment: "archive",
          outcome: "failed",
          permanentErasure: false,
          releaseBlocked: true,
        })
      );
      throw error;
    }
    recordIncident(
      input.deliveryId,
      `containment:${input.deliveryId}:${input.messageId}`,
      input.classification,
      JSON.stringify({
        reason: input.evidence,
        containment: "archive",
        permanentErasure: false,
        releaseBlocked: true,
      })
    );
  }

  async function runOnce() {
    const retention = await expireNotifications();
    const terminalRecordsCleaned = cleanupTerminalRecords();
    return { ...retention, terminalRecordsCleaned };
  }

  function startPeriodicLifecycle(intervalMs = LIFECYCLE_INTERVAL_MS) {
    let active: Promise<Awaited<ReturnType<typeof runOnce>>> | undefined;
    const run = () => {
      if (active) return;
      active = runOnce().finally(() => {
        active = undefined;
      });
      void active.catch(() => undefined);
    };
    run();
    const timer = setInterval(run, intervalMs);
    if (typeof timer === "object" && "unref" in timer) timer.unref();
    return async () => {
      clearInterval(timer);
      await active;
    };
  }

  return {
    expireNotifications,
    cleanupTerminalRecords,
    eraseAccount,
    containIncorrectNotification,
    runOnce,
    startPeriodicLifecycle,
  };
}

export const notificationRetentionPolicy = {
  visibleLifetimeMs: VISIBLE_LIFETIME_MS,
  lifecycleIntervalMs: LIFECYCLE_INTERVAL_MS,
  providerPerMessageErasure: "required_but_unsupported_by_knock" as const,
};
