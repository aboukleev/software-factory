import { eq } from "drizzle-orm";
import { db } from "~/db";
import {
  notificationDeliveries,
  notificationDeliveryIncidents,
  notificationDeliveryTransitions,
  notificationDispatcherHeartbeats,
  notificationEvents,
  notificationOperationControls,
} from "~/db/schema";

type OperationsDatabase = typeof db;
export type NotificationControlState = {
  creationEnabled: boolean;
  dispatchEnabled: boolean;
  feedEnabled: boolean;
  updatedAt: string | null;
};

export const notificationOperationalObjectives = {
  firstAttemptWithinMs: 30_000,
  storedWithinOneMinutePercent: 95,
  storedWithinFiveMinutesPercent: 99,
} as const;

function summarizeLatency(values: number[]) {
  if (values.length === 0) {
    return { count: 0, averageMs: null, maximumMs: null };
  }
  return {
    count: values.length,
    averageMs: Math.round(
      values.reduce((total, value) => total + value, 0) / values.length
    ),
    maximumMs: Math.max(...values),
  };
}

const defaultControls: NotificationControlState = {
  creationEnabled: false,
  dispatchEnabled: true,
  feedEnabled: false,
  updatedAt: null,
};

export function createNotificationOperations({
  database = db,
  now = () => new Date(),
  log = (entry) => {
    if (process.env.NODE_ENV !== "test") console.info(JSON.stringify(entry));
  },
}: {
  database?: OperationsDatabase;
  now?: () => Date;
  log?: (entry: Record<string, unknown>) => void;
} = {}) {
  function getControls(): NotificationControlState {
    const row = database
      .select()
      .from(notificationOperationControls)
      .where(eq(notificationOperationControls.id, 1))
      .get();
    return row
      ? {
          creationEnabled: row.creationEnabled,
          dispatchEnabled: row.dispatchEnabled,
          feedEnabled: row.feedEnabled,
          updatedAt: row.updatedAt,
        }
      : defaultControls;
  }

  function setControls(
    values: Partial<
      Pick<
        NotificationControlState,
        "creationEnabled" | "dispatchEnabled" | "feedEnabled"
      >
    >
  ) {
    const next = {
      ...getControls(),
      ...values,
      updatedAt: now().toISOString(),
    };
    database
      .insert(notificationOperationControls)
      .values({ id: 1, ...next, updatedAt: next.updatedAt! })
      .onConflictDoUpdate({
        target: notificationOperationControls.id,
        set: next,
      })
      .run();
    log({
      type: "notification_controls_changed",
      ...values,
      occurredAt: next.updatedAt,
    });
    return next;
  }

  function recordHeartbeat() {
    const observedAt = now().toISOString();
    database
      .insert(notificationDispatcherHeartbeats)
      .values({ id: 1, observedAt })
      .onConflictDoUpdate({
        target: notificationDispatcherHeartbeats.id,
        set: { observedAt },
      })
      .run();
    return observedAt;
  }

  function recordTransition(
    deliveryId: number,
    fromStatus: string | null,
    toStatus: string,
    outcomeCode: string,
    occurredAt = now().toISOString()
  ) {
    const correlation = database
      .select({
        notificationEventId: notificationDeliveries.notificationEventId,
        eventIdentity: notificationEvents.identity,
      })
      .from(notificationDeliveries)
      .innerJoin(
        notificationEvents,
        eq(notificationDeliveries.notificationEventId, notificationEvents.id)
      )
      .where(eq(notificationDeliveries.id, deliveryId))
      .get();
    if (!correlation) throw new Error(`Delivery ${deliveryId} was not found`);
    database
      .insert(notificationDeliveryTransitions)
      .values({
        deliveryId,
        notificationEventId: correlation.notificationEventId,
        fromStatus,
        toStatus,
        outcomeCode,
        occurredAt,
      })
      .run();
    log({
      type: "notification_delivery_transition",
      deliveryId,
      notificationEventId: correlation.notificationEventId,
      eventIdentity: correlation.eventIdentity,
      fromStatus,
      toStatus,
      outcomeCode,
      occurredAt,
    });
  }

  function snapshot() {
    const observedAt = now();
    const deliveries = database
      .select({
        delivery: notificationDeliveries,
        occurredAt: notificationEvents.occurredAt,
      })
      .from(notificationDeliveries)
      .innerJoin(
        notificationEvents,
        eq(notificationDeliveries.notificationEventId, notificationEvents.id)
      )
      .all();
    const transitions = database
      .select()
      .from(notificationDeliveryTransitions)
      .all();
    const incidents = database
      .select()
      .from(notificationDeliveryIncidents)
      .all();
    const heartbeat = database
      .select()
      .from(notificationDispatcherHeartbeats)
      .where(eq(notificationDispatcherHeartbeats.id, 1))
      .get();
    const due = deliveries.filter(
      ({ delivery }) =>
        ["queued", "retry_scheduled"].includes(delivery.status) &&
        Date.parse(delivery.nextAttemptAt) <= observedAt.getTime()
    );
    const inFlight = deliveries.filter(
      ({ delivery }) => delivery.status === "attempting"
    );
    const oldestDueAgeMs = due.length
      ? Math.max(
          ...due.map(({ delivery }) =>
            Math.max(
              0,
              observedAt.getTime() - Date.parse(delivery.nextAttemptAt)
            )
          )
        )
      : 0;
    const unresolved = deliveries.filter(({ delivery }) =>
      ["accepted", "outcome_unknown"].includes(delivery.status)
    );
    const oldestUnresolvedAgeMs = unresolved.length
      ? Math.max(
          ...unresolved.map(({ delivery }) =>
            Math.max(
              0,
              observedAt.getTime() -
                Date.parse(delivery.acceptedAt ?? observedAt.toISOString())
            )
          )
        )
      : 0;
    const firstAttemptLatenciesMs = deliveries.flatMap(
      ({ delivery, occurredAt }) =>
        delivery.firstAttemptAt
          ? [Date.parse(delivery.firstAttemptAt) - Date.parse(occurredAt)]
          : []
    );
    const acceptedLatenciesMs = deliveries.flatMap(
      ({ delivery, occurredAt }) =>
        delivery.acceptedAt
          ? [Date.parse(delivery.acceptedAt) - Date.parse(occurredAt)]
          : []
    );
    const deliveredLatenciesMs = deliveries.flatMap(
      ({ delivery, occurredAt }) =>
        delivery.deliveredAt
          ? [Date.parse(delivery.deliveredAt) - Date.parse(occurredAt)]
          : []
    );
    const percentWithin = (values: number[], threshold: number) =>
      values.length
        ? (values.filter((value) => value <= threshold).length /
            values.length) *
          100
        : null;
    const attemptsByCategory = Object.fromEntries(
      ["first_attempt", "retry_attempt", "expired_lease_recovered"].map(
        (code) => [
          code,
          transitions.filter((item) => item.outcomeCode === code).length,
        ]
      )
    );
    const outcomesByCategory = Object.fromEntries(
      [...new Set(transitions.map((item) => item.outcomeCode))]
        .sort()
        .map((code) => [
          code,
          transitions.filter((item) => item.outcomeCode === code).length,
        ])
    );
    const metrics = {
      attempts: transitions.filter((item) => item.toStatus === "attempting")
        .length,
      attemptsByCategory,
      outcomesByCategory,
      permanentFailures: deliveries.filter(
        ({ delivery }) => delivery.status === "permanently_failed"
      ).length,
      unknownOutcomes: deliveries.filter(
        ({ delivery }) => delivery.status === "outcome_unknown"
      ).length,
      cancellations: deliveries.filter(
        ({ delivery }) => delivery.status === "cancelled"
      ).length,
      confirmedDuplicates: incidents.length,
      expiredLeaseRecoveries: transitions.filter(
        (item) => item.outcomeCode === "expired_lease_recovered"
      ).length,
      unresolvedAccepted: unresolved.length,
      dispatcherHeartbeatAgeMs: heartbeat
        ? Math.max(0, observedAt.getTime() - Date.parse(heartbeat.observedAt))
        : null,
      acceptedLatency: summarizeLatency(acceptedLatenciesMs),
      deliveredLatency: summarizeLatency(deliveredLatenciesMs),
      firstAttemptWithin30SecondsPercent: percentWithin(
        firstAttemptLatenciesMs,
        30_000
      ),
      storedWithinOneMinutePercent: percentWithin(deliveredLatenciesMs, 60_000),
      storedWithinFiveMinutesPercent: percentWithin(
        deliveredLatenciesMs,
        300_000
      ),
    };
    const alerts: string[] = [];
    if (
      !heartbeat ||
      observedAt.getTime() - Date.parse(heartbeat.observedAt) > 120_000
    )
      alerts.push("dispatcher_heartbeat_missing");
    if (oldestDueAgeMs > 300_000) alerts.push("oldest_due_over_five_minutes");
    if (oldestUnresolvedAgeMs > 300_000)
      alerts.push("acceptance_unresolved_over_five_minutes");
    if (
      deliveries.some(
        ({ delivery }) =>
          delivery.status === "permanently_failed" &&
          ["provider_permanent", "invalid_immutable_payload"].includes(
            delivery.errorCategory ?? ""
          )
      )
    )
      alerts.push("permanent_configuration_or_authentication_failure");
    if (metrics.unknownOutcomes > 0) alerts.push("unknown_outcome");
    if (metrics.confirmedDuplicates > 0) alerts.push("confirmed_duplicate");
    if (
      deliveredLatenciesMs.length >= 20 &&
      ((metrics.storedWithinOneMinutePercent ?? 100) < 95 ||
        (metrics.storedWithinFiveMinutesPercent ?? 100) < 99)
    )
      alerts.push("delivery_objective_sustained_miss");
    return {
      observedAt: observedAt.toISOString(),
      heartbeatAt: heartbeat?.observedAt ?? null,
      backlog: { due: due.length, inFlight: inFlight.length, oldestDueAgeMs },
      oldestUnresolvedAgeMs,
      metrics,
      alerts,
      objectives: notificationOperationalObjectives,
    };
  }

  return {
    getControls,
    setControls,
    recordHeartbeat,
    recordTransition,
    snapshot,
  };
}

export const notificationOperations = createNotificationOperations();
