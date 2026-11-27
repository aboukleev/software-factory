import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, lte, or, sql } from "drizzle-orm";
import { db } from "~/db";
import {
  comments,
  notificationDeliveries,
  notificationEvents,
  users,
} from "~/db/schema";
import {
  notificationPayloadSchema,
  NotificationProviderError,
  type NotificationPayload,
  type NotificationDeliveryProvider,
} from "~/services/notificationProvider";
import { createNotificationOperations } from "~/services/notificationOperations.server";
import type { NotificationOutcomeCode } from "~/services/notificationOperations.server";

const DEFAULT_POLL_INTERVAL_MS = 15_000;
const DEFAULT_LEASE_MS = 120_000;
const DEFAULT_TIMEOUT_MS = 15_000;
const RETRY_WINDOW_MS = 24 * 60 * 60 * 1_000;
const RETRY_DELAYS_MS = [
  60_000,
  5 * 60_000,
  15 * 60_000,
  60 * 60_000,
  4 * 60 * 60_000,
  12 * 60 * 60_000,
] as const;

type DispatcherDatabase = typeof db;

type DispatcherOptions = {
  database?: DispatcherDatabase;
  provider: NotificationDeliveryProvider;
  ownerId?: string;
  concurrency?: number;
  pollIntervalMs?: number;
  leaseMs?: number;
  timeoutMs?: number;
  now?: () => Date;
  random?: () => number;
};

type ClaimedDelivery = {
  id: number;
  idempotencyKey: string;
  providerPayload: string;
  attemptCount: number;
  occurredAt: string;
  previousStatus: "queued" | "retry_scheduled" | "attempting";
};

type ExpiredDelivery = {
  id: number;
  previousStatus: ClaimedDelivery["previousStatus"];
};

type Failure = {
  category: NotificationOutcomeCode;
  retryable: boolean;
  outcomeUnknown?: boolean;
  retryAfterMs?: number;
};

function classifyFailure(error: unknown): Failure {
  if (error instanceof NotificationProviderError) {
    const retryable =
      error.status === 408 || error.status === 429 || error.status >= 500;
    return {
      category: retryable ? `http_${error.status}` : "provider_permanent",
      retryable,
      retryAfterMs: error.retryAfterMs,
    };
  }
  if (error instanceof DOMException && error.name === "AbortError") {
    return {
      category: "timeout_ambiguous",
      retryable: false,
      outcomeUnknown: true,
    };
  }
  if (error instanceof Error && error.message === "provider_timeout") {
    return {
      category: "timeout_ambiguous",
      retryable: false,
      outcomeUnknown: true,
    };
  }
  return {
    category: "network_ambiguous",
    retryable: false,
    outcomeUnknown: true,
  };
}

function timerUnref(timer: ReturnType<typeof setTimeout>) {
  if (typeof timer === "object" && "unref" in timer) timer.unref();
}

export function createNotificationDispatcher(options: DispatcherOptions) {
  const database = options.database ?? db;
  const ownerId = options.ownerId ?? randomUUID();
  const concurrency = Math.max(1, options.concurrency ?? 4);
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = options.now ?? (() => new Date());
  const random = options.random ?? Math.random;
  const operations = createNotificationOperations({ database, now });
  let stopped = true;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let wakePending = false;
  let runInProgress: Promise<void> | undefined;
  const activeRuns = new Set<Promise<void>>();

  function eligibleAt(nowIso: string) {
    return or(
      and(
        inArray(notificationDeliveries.status, ["queued", "retry_scheduled"]),
        lte(notificationDeliveries.nextAttemptAt, nowIso)
      ),
      and(
        eq(notificationDeliveries.status, "attempting"),
        lte(notificationDeliveries.leaseExpiresAt, nowIso)
      )
    );
  }

  function claimDue(limit: number) {
    const claimTime = now();
    const nowIso = claimTime.toISOString();
    const leaseExpiresAt = new Date(
      claimTime.getTime() + leaseMs
    ).toISOString();
    return database.transaction((tx) => {
      const candidates = tx
        .select({
          id: notificationDeliveries.id,
          status: notificationDeliveries.status,
          occurredAt: notificationEvents.occurredAt,
        })
        .from(notificationDeliveries)
        .innerJoin(
          notificationEvents,
          eq(notificationDeliveries.notificationEventId, notificationEvents.id)
        )
        .where(eligibleAt(nowIso))
        .orderBy(
          asc(notificationEvents.occurredAt),
          asc(notificationDeliveries.id)
        )
        .limit(limit * 4)
        .all();
      const claimed: ClaimedDelivery[] = [];
      const expired: ExpiredDelivery[] = [];

      for (const candidate of candidates) {
        if (claimed.length === limit) break;
        const cutoff = Date.parse(candidate.occurredAt) + RETRY_WINDOW_MS;
        if (claimTime.getTime() >= cutoff) {
          const changed = tx
            .update(notificationDeliveries)
            .set({
              status: "permanently_failed",
              terminalAt: nowIso,
              errorCategory: "retry_window_expired",
              leaseOwner: null,
              leaseExpiresAt: null,
            })
            .where(
              and(
                eq(notificationDeliveries.id, candidate.id),
                eligibleAt(nowIso)
              )
            )
            .returning({ id: notificationDeliveries.id })
            .get();
          if (changed) {
            expired.push({
              id: changed.id,
              previousStatus:
                candidate.status as ExpiredDelivery["previousStatus"],
            });
          }
          continue;
        }
        const row = tx
          .update(notificationDeliveries)
          .set({
            status: "attempting",
            leaseOwner: ownerId,
            leaseExpiresAt,
            attemptCount: sql`${notificationDeliveries.attemptCount} + 1`,
            firstAttemptAt: sql`coalesce(${notificationDeliveries.firstAttemptAt}, ${nowIso})`,
            lastAttemptAt: nowIso,
            errorCategory: null,
          })
          .where(
            and(eq(notificationDeliveries.id, candidate.id), eligibleAt(nowIso))
          )
          .returning({
            id: notificationDeliveries.id,
            idempotencyKey: notificationDeliveries.idempotencyKey,
            providerPayload: notificationDeliveries.providerPayload,
            attemptCount: notificationDeliveries.attemptCount,
          })
          .get();
        if (row)
          claimed.push({
            ...row,
            occurredAt: candidate.occurredAt,
            previousStatus:
              candidate.status as ClaimedDelivery["previousStatus"],
          });
      }
      return { claimed, expired };
    });
  }

  function sourceOrRecipientWasDeleted(deliveryId: number) {
    const row = database
      .select({
        sourceDeletedAt: comments.deletedAt,
        recipientId: users.id,
      })
      .from(notificationDeliveries)
      .innerJoin(
        notificationEvents,
        eq(notificationDeliveries.notificationEventId, notificationEvents.id)
      )
      .innerJoin(comments, eq(notificationEvents.sourceCommentId, comments.id))
      .leftJoin(users, eq(notificationDeliveries.recipientId, users.id))
      .where(eq(notificationDeliveries.id, deliveryId))
      .get();
    return !row || row.sourceDeletedAt !== null || row.recipientId === null;
  }

  function finish(
    deliveryId: number,
    values: Partial<typeof notificationDeliveries.$inferInsert>,
    outcomeCode: NotificationOutcomeCode
  ) {
    const before = database
      .select({ status: notificationDeliveries.status })
      .from(notificationDeliveries)
      .where(eq(notificationDeliveries.id, deliveryId))
      .get();
    const changed = database
      .update(notificationDeliveries)
      .set({ ...values, leaseOwner: null, leaseExpiresAt: null })
      .where(
        and(
          eq(notificationDeliveries.id, deliveryId),
          eq(notificationDeliveries.status, "attempting"),
          eq(notificationDeliveries.leaseOwner, ownerId)
        )
      )
      .returning({ status: notificationDeliveries.status })
      .get();
    if (before && changed && before.status !== changed.status) {
      operations.recordTransition(
        deliveryId,
        before.status,
        changed.status,
        outcomeCode
      );
    }
  }

  function scheduleFailure(delivery: ClaimedDelivery, failure: Failure) {
    const failureTime = now();
    const failureIso = failureTime.toISOString();
    if (failure.outcomeUnknown) {
      finish(
        delivery.id,
        {
          status: "outcome_unknown",
          errorCategory: failure.category,
          outcomeCheckedAt: failureIso,
          outcomeNextCheckAt: null,
        },
        failure.category
      );
      return;
    }
    if (!failure.retryable) {
      finish(
        delivery.id,
        {
          status: "permanently_failed",
          terminalAt: failureIso,
          errorCategory: failure.category,
        },
        failure.category
      );
      return;
    }
    const baseDelay = RETRY_DELAYS_MS[delivery.attemptCount - 1];
    if (baseDelay === undefined) {
      finish(
        delivery.id,
        {
          status: "permanently_failed",
          terminalAt: failureIso,
          errorCategory: "retry_exhausted",
        },
        "retry_exhausted"
      );
      return;
    }
    const jitteredDelay = Math.round(baseDelay * (0.8 + random() * 0.4));
    const delay = failure.retryAfterMs ?? jitteredDelay;
    const nextAttempt = failureTime.getTime() + delay;
    const cutoff = Date.parse(delivery.occurredAt) + RETRY_WINDOW_MS;
    if (delay < 0 || nextAttempt >= cutoff) {
      finish(
        delivery.id,
        {
          status: "permanently_failed",
          terminalAt: failureIso,
          errorCategory: "retry_window_expired",
        },
        "retry_window_expired"
      );
      return;
    }
    finish(
      delivery.id,
      {
        status: "retry_scheduled",
        nextAttemptAt: new Date(nextAttempt).toISOString(),
        errorCategory: failure.category,
      },
      failure.category
    );
  }

  async function processDelivery(delivery: ClaimedDelivery) {
    if (sourceOrRecipientWasDeleted(delivery.id)) {
      finish(
        delivery.id,
        {
          status: "cancelled",
          terminalAt: now().toISOString(),
          errorCategory: "source_or_recipient_deleted",
        },
        "source_or_recipient_deleted"
      );
      return;
    }

    let payload: NotificationPayload;
    try {
      payload = notificationPayloadSchema.parse(
        JSON.parse(delivery.providerPayload)
      );
    } catch {
      finish(
        delivery.id,
        {
          status: "permanently_failed",
          terminalAt: now().toISOString(),
          errorCategory: "invalid_immutable_payload",
        },
        "invalid_immutable_payload"
      );
      return;
    }

    const controller = new AbortController();
    const renewal = setInterval(
      () => {
        const renewalTime = now();
        database
          .update(notificationDeliveries)
          .set({
            leaseExpiresAt: new Date(
              renewalTime.getTime() + leaseMs
            ).toISOString(),
          })
          .where(
            and(
              eq(notificationDeliveries.id, delivery.id),
              eq(notificationDeliveries.status, "attempting"),
              eq(notificationDeliveries.leaseOwner, ownerId)
            )
          )
          .run();
      },
      Math.max(1, Math.min(leaseMs / 2, timeoutMs / 2))
    );
    timerUnref(renewal);
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;

    try {
      const providerCall = Promise.resolve(
        options.provider.trigger(delivery.idempotencyKey, payload, {
          signal: controller.signal,
        })
      );
      const timeoutFailure = new Promise<never>((_resolve, reject) => {
        timeoutTimer = setTimeout(() => {
          controller.abort();
          reject(new Error("provider_timeout"));
        }, timeoutMs);
        timerUnref(timeoutTimer);
      });
      const result = await Promise.race([providerCall, timeoutFailure]);
      finish(
        delivery.id,
        {
          status: "accepted",
          acceptedAt: now().toISOString(),
          errorCategory: null,
          providerRequestId: result?.requestId ?? null,
          providerWorkflowRunId: result?.workflowRunId ?? null,
        },
        "provider_accepted"
      );
    } catch (error) {
      scheduleFailure(delivery, classifyFailure(error));
    } finally {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      controller.abort();
      clearInterval(renewal);
    }
  }

  async function runBatch() {
    operations.recordHeartbeat();
    if (!operations.getControls().dispatchEnabled) return;
    const { claimed, expired } = claimDue(concurrency);
    for (const delivery of expired) {
      operations.recordTransition(
        delivery.id,
        delivery.previousStatus,
        "permanently_failed",
        "retry_window_expired"
      );
    }
    for (const delivery of claimed) {
      operations.recordTransition(
        delivery.id,
        delivery.previousStatus,
        "attempting",
        delivery.previousStatus === "attempting"
          ? "expired_lease_recovered"
          : delivery.attemptCount === 1
            ? "first_attempt"
            : "retry_attempt"
      );
    }
    await Promise.all(claimed.map(processDelivery));
  }

  function runOnce() {
    if (runInProgress) return runInProgress;
    runInProgress = runBatch().finally(() => {
      runInProgress = undefined;
    });
    return runInProgress;
  }

  function trackRun() {
    if (stopped) return;
    const run = runOnce()
      .catch(() => undefined)
      .finally(() => {
        activeRuns.delete(run);
        if (wakePending && !stopped) {
          wakePending = false;
          queueMicrotask(trackRun);
        }
      });
    activeRuns.add(run);
  }

  function wake() {
    if (stopped || wakePending) return;
    wakePending = true;
    if (activeRuns.size > 0) return;
    queueMicrotask(() => {
      wakePending = false;
      trackRun();
    });
  }

  function start() {
    if (!stopped) return;
    stopped = false;
    wake();
    pollTimer = setInterval(trackRun, pollIntervalMs);
    timerUnref(pollTimer);
  }

  async function stop() {
    stopped = true;
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = undefined;
    await Promise.all(activeRuns);
  }

  return { runOnce, start, stop, wake };
}

export const notificationRetryPolicy = {
  delaysMs: RETRY_DELAYS_MS,
  retryWindowMs: RETRY_WINDOW_MS,
  pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
  leaseMs: DEFAULT_LEASE_MS,
  timeoutMs: DEFAULT_TIMEOUT_MS,
} as const;
