import { afterEach, describe, expect, test, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  comments,
  enrollments,
  lessons,
  modules,
  notificationDeliveries,
  notificationDeliveryTransitions,
  notificationEvents,
  notificationOperationControls,
  UserRole,
  users,
} from "~/db/schema";
import {
  createNotificationDispatcher,
  notificationRetryPolicy,
} from "~/services/notificationDispatcher.server";
import {
  FakeKnockAdapter,
  NotificationProviderError,
  type NotificationPayload,
} from "~/services/notificationProvider";
import { createTestDb, seedBaseData } from "~/test/setup";

function queuedDelivery(database: ReturnType<typeof createTestDb>) {
  const { user, instructor, course } = seedBaseData(database);
  database
    .insert(enrollments)
    .values({ userId: user.id, courseId: course.id })
    .run();
  const lessonModule = database
    .insert(modules)
    .values({ courseId: course.id, title: "Module", position: 1 })
    .returning()
    .get();
  const lesson = database
    .insert(lessons)
    .values({ moduleId: lessonModule.id, title: "Lesson", position: 1 })
    .returning()
    .get();
  const source = database
    .insert(comments)
    .values({
      userId: user.id,
      lessonId: lesson.id,
      parentId: null,
      body: "How does dispatch recover?",
      createdAt: "2026-01-01T00:00:00.000Z",
    })
    .returning()
    .get();
  const identity = `question.created:${source.id}`;
  const event = database
    .insert(notificationEvents)
    .values({
      identity,
      kind: "question.created",
      occurredAt: source.createdAt,
      sourceCommentId: source.id,
      rootQuestionId: source.id,
      actorId: user.id,
      actorCapacity: "student",
      recipientId: instructor.id,
      courseId: course.id,
      lessonId: lesson.id,
    })
    .returning()
    .get();
  const payload = {
    eventIdentity: identity,
    eventKind: "question.created" as const,
    occurredAt: source.createdAt,
    sourceCommentId: source.id,
    rootQuestionId: source.id,
    recipientId: instructor.id,
    courseId: course.id,
    lessonId: lesson.id,
  };
  const delivery = database
    .insert(notificationDeliveries)
    .values({
      notificationEventId: event.id,
      recipientId: instructor.id,
      channel: "in_app",
      workflowKey: "student-question-created",
      idempotencyKey: `${identity}:${instructor.id}:in_app`,
      providerPayload: JSON.stringify(payload),
      status: "queued",
      nextAttemptAt: source.createdAt,
    })
    .returning()
    .get();
  return {
    delivery,
    event,
    payload,
    recipientId: instructor.id,
    actorId: user.id,
    lessonId: lesson.id,
  };
}

function deliveryRow(database: ReturnType<typeof createTestDb>, id: number) {
  const row = database
    .select()
    .from(notificationDeliveries)
    .where(eq(notificationDeliveries.id, id))
    .get();
  if (!row) throw new Error(`Delivery ${id} was not found`);
  return row;
}

function addLaterDelivery(
  database: ReturnType<typeof createTestDb>,
  queued: ReturnType<typeof queuedDelivery>,
  occurredAt: string
) {
  const source = database
    .insert(comments)
    .values({
      userId: queued.actorId,
      lessonId: queued.lessonId,
      parentId: null,
      body: "A later question",
      createdAt: occurredAt,
    })
    .returning()
    .get();
  const identity = `question.created:${source.id}`;
  const event = database
    .insert(notificationEvents)
    .values({
      ...queued.event,
      id: undefined,
      identity,
      occurredAt,
      sourceCommentId: source.id,
      rootQuestionId: source.id,
    })
    .returning()
    .get();
  const payload = {
    ...queued.payload,
    eventIdentity: identity,
    occurredAt,
    sourceCommentId: source.id,
    rootQuestionId: source.id,
  };
  return database
    .insert(notificationDeliveries)
    .values({
      ...queued.delivery,
      id: undefined,
      notificationEventId: event.id,
      idempotencyKey: `${identity}:${queued.recipientId}:in_app`,
      providerPayload: JSON.stringify(payload),
      nextAttemptAt: occurredAt,
    })
    .returning()
    .get();
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Notification dispatcher", () => {
  test("preserves durable due work while dispatch claims are paused", async () => {
    const database = createTestDb();
    const queued = queuedDelivery(database);
    database
      .insert(notificationOperationControls)
      .values({
        id: 1,
        creationEnabled: true,
        dispatchEnabled: false,
        feedEnabled: true,
        updatedAt: "2026-01-01T00:00:00.000Z",
      })
      .run();
    const provider = new FakeKnockAdapter();

    await createNotificationDispatcher({
      database,
      provider,
      now: () => new Date("2026-01-01T00:00:01.000Z"),
    }).runOnce();

    expect(deliveryRow(database, queued.delivery.id).status).toBe("queued");
    expect(provider.list(queued.recipientId)).toEqual([]);
  });

  test("resumes queued work after restart and records provider acceptance", async () => {
    const database = createTestDb();
    const queued = queuedDelivery(database);
    const provider = new FakeKnockAdapter();
    const dispatcher = createNotificationDispatcher({
      database,
      provider,
      ownerId: "restarted-process",
      now: () => new Date("2026-01-01T00:00:01.000Z"),
    });

    await dispatcher.runOnce();

    expect(provider.list(queued.recipientId)).toEqual([
      expect.objectContaining({
        idempotencyKey: queued.delivery.idempotencyKey,
        ...queued.payload,
      }),
    ]);
    expect(
      database
        .select()
        .from(notificationDeliveries)
        .where(eq(notificationDeliveries.id, queued.delivery.id))
        .get()
    ).toEqual(
      expect.objectContaining({
        status: "accepted",
        attemptCount: 1,
        leaseOwner: null,
        leaseExpiresAt: null,
        acceptedAt: "2026-01-01T00:00:01.000Z",
      })
    );
  });

  test("reclaims an expired in-flight lease without creating a duplicate logical Notification", async () => {
    const database = createTestDb();
    const queued = queuedDelivery(database);
    database
      .update(notificationDeliveries)
      .set({
        status: "attempting",
        attemptCount: 1,
        leaseOwner: "crashed-process",
        leaseExpiresAt: "2026-01-01T00:00:30.000Z",
      })
      .where(eq(notificationDeliveries.id, queued.delivery.id))
      .run();
    const provider = new FakeKnockAdapter();

    await createNotificationDispatcher({
      database,
      provider,
      ownerId: "replacement-process",
      now: () => new Date("2026-01-01T00:00:31.000Z"),
    }).runOnce();

    expect(provider.list(queued.recipientId)).toHaveLength(1);
    expect(deliveryRow(database, queued.delivery.id)).toMatchObject({
      status: "accepted",
      attemptCount: 2,
    });
  });

  test("allows only one competing dispatcher to claim a Delivery", async () => {
    const database = createTestDb();
    queuedDelivery(database);
    let release: (() => void) | undefined;
    const provider = {
      trigger: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          })
      ),
    };
    const options = {
      database,
      provider,
      now: () => new Date("2026-01-01T00:00:01.000Z"),
    };

    const first = createNotificationDispatcher({
      ...options,
      ownerId: "process-a",
    }).runOnce();
    const second = createNotificationDispatcher({
      ...options,
      ownerId: "process-b",
    }).runOnce();
    await Promise.resolve();

    expect(provider.trigger).toHaveBeenCalledTimes(1);
    release?.();
    await Promise.all([first, second]);
  });

  test("records an ambiguous timeout as outcome unknown without blind retry", async () => {
    vi.useFakeTimers();
    const database = createTestDb();
    const queued = queuedDelivery(database);
    const dispatcher = createNotificationDispatcher({
      database,
      provider: { trigger: () => new Promise(() => undefined) },
      now: () => new Date("2026-01-01T00:00:01.000Z"),
      random: () => 0,
    });

    const run = dispatcher.runOnce();
    await vi.advanceTimersByTimeAsync(notificationRetryPolicy.timeoutMs);
    await run;

    expect(deliveryRow(database, queued.delivery.id)).toMatchObject({
      status: "outcome_unknown",
      errorCategory: "timeout_ambiguous",
      outcomeNextCheckAt: null,
    });
  });

  test("renews the lease while a provider call remains in flight", async () => {
    vi.useFakeTimers();
    const database = createTestDb();
    const queued = queuedDelivery(database);
    let currentMs = Date.parse("2026-01-01T00:00:01.000Z");
    let release: (() => void) | undefined;
    const dispatcher = createNotificationDispatcher({
      database,
      provider: {
        trigger: () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      },
      leaseMs: 1_000,
      timeoutMs: 10_000,
      now: () => new Date(currentMs),
    });

    const run = dispatcher.runOnce();
    currentMs += 500;
    await vi.advanceTimersByTimeAsync(500);

    expect(deliveryRow(database, queued.delivery.id)?.leaseExpiresAt).toBe(
      "2026-01-01T00:00:02.500Z"
    );
    release?.();
    await run;
  });

  test("reuses the immutable payload and idempotency key on every attempt", async () => {
    const database = createTestDb();
    const queued = queuedDelivery(database);
    let currentMs = Date.parse("2026-01-01T00:00:01.000Z");
    const attempts: Array<{ key: string; payload: NotificationPayload }> = [];
    const dispatcher = createNotificationDispatcher({
      database,
      provider: {
        trigger(key, payload) {
          attempts.push({ key, payload });
          if (attempts.length === 1) {
            throw new NotificationProviderError("unavailable", 503);
          }
        },
      },
      now: () => new Date(currentMs),
      random: () => 0.5,
    });

    await dispatcher.runOnce();
    currentMs = Date.parse(
      deliveryRow(database, queued.delivery.id).nextAttemptAt
    );
    database
      .update(users)
      .set({ role: UserRole.Instructor })
      .where(eq(users.id, queued.actorId))
      .run();
    await dispatcher.runOnce();

    expect(attempts).toEqual([
      { key: queued.delivery.idempotencyKey, payload: queued.payload },
      { key: queued.delivery.idempotencyKey, payload: queued.payload },
    ]);
  });

  test("polls for committed work every 15 seconds", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:01.000Z"));
    const database = createTestDb();
    const first = queuedDelivery(database);
    const provider = new FakeKnockAdapter();
    const dispatcher = createNotificationDispatcher({ database, provider });
    dispatcher.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(deliveryRow(database, first.delivery.id)?.status).toBe("accepted");

    const later = addLaterDelivery(database, first, "2026-01-01T00:00:01.000Z");
    await vi.advanceTimersByTimeAsync(
      notificationRetryPolicy.pollIntervalMs - 1
    );
    expect(deliveryRow(database, later.id)?.status).toBe("queued");
    await vi.advanceTimersByTimeAsync(1);
    expect(deliveryRow(database, later.id)?.status).toBe("accepted");
    await dispatcher.stop();
  });

  test("uses the complete retry schedule and stops after exhaustion", async () => {
    const database = createTestDb();
    const queued = queuedDelivery(database);
    let currentMs = Date.parse("2026-01-01T00:00:01.000Z");
    const provider = {
      trigger: () =>
        Promise.reject(new NotificationProviderError("unavailable", 503)),
    };
    const dispatcher = createNotificationDispatcher({
      database,
      provider,
      now: () => new Date(currentMs),
      random: () => 0.5,
    });

    for (const expectedDelay of notificationRetryPolicy.delaysMs) {
      await dispatcher.runOnce();
      const row = deliveryRow(database, queued.delivery.id);
      expect(Date.parse(row.nextAttemptAt) - currentMs).toBe(expectedDelay);
      expect(row.status).toBe("retry_scheduled");
      currentMs = Date.parse(row.nextAttemptAt);
    }
    await dispatcher.runOnce();

    expect(deliveryRow(database, queued.delivery.id)).toMatchObject({
      status: "permanently_failed",
      attemptCount: 7,
      errorCategory: "retry_exhausted",
    });
  });

  test("records a generic network failure as outcome unknown without retry", async () => {
    const database = createTestDb();
    const queued = queuedDelivery(database);
    await createNotificationDispatcher({
      database,
      provider: { trigger: () => Promise.reject(new TypeError("offline")) },
      now: () => new Date("2026-01-01T00:00:01.000Z"),
    }).runOnce();

    expect(deliveryRow(database, queued.delivery.id)).toMatchObject({
      status: "outcome_unknown",
      errorCategory: "network_ambiguous",
      attemptCount: 1,
    });
  });

  test("honors usable Retry-After and permanently fails non-transient 4xx responses", async () => {
    const database = createTestDb();
    const queued = queuedDelivery(database);
    const retryAfterDispatcher = createNotificationDispatcher({
      database,
      provider: {
        trigger: () =>
          Promise.reject(
            new NotificationProviderError("rate limited", 429, 90_000)
          ),
      },
      now: () => new Date("2026-01-01T00:00:01.000Z"),
    });

    await retryAfterDispatcher.runOnce();
    expect(deliveryRow(database, queued.delivery.id)).toMatchObject({
      status: "retry_scheduled",
      nextAttemptAt: "2026-01-01T00:01:31.000Z",
      errorCategory: "http_429",
    });

    database
      .update(notificationDeliveries)
      .set({ nextAttemptAt: "2026-01-01T00:01:31.000Z" })
      .where(eq(notificationDeliveries.id, queued.delivery.id))
      .run();
    await createNotificationDispatcher({
      database,
      provider: {
        trigger: () =>
          Promise.reject(new NotificationProviderError("invalid", 400)),
      },
      now: () => new Date("2026-01-01T00:01:31.000Z"),
    }).runOnce();
    expect(deliveryRow(database, queued.delivery.id)).toMatchObject({
      status: "permanently_failed",
      errorCategory: "provider_permanent",
    });
  });

  test("does not start an automatic attempt once the Notification Event is 24 hours old", async () => {
    const database = createTestDb();
    const queued = queuedDelivery(database);
    const provider = { trigger: vi.fn() };

    await createNotificationDispatcher({
      database,
      provider,
      now: () => new Date("2026-01-02T00:00:00.000Z"),
    }).runOnce();

    expect(provider.trigger).not.toHaveBeenCalled();
    expect(deliveryRow(database, queued.delivery.id)).toMatchObject({
      status: "permanently_failed",
      errorCategory: "retry_window_expired",
    });
    expect(
      database
        .select()
        .from(notificationDeliveryTransitions)
        .where(
          eq(notificationDeliveryTransitions.deliveryId, queued.delivery.id)
        )
        .all()
    ).toEqual([
      expect.objectContaining({
        fromStatus: "queued",
        toStatus: "permanently_failed",
        outcomeCode: "retry_window_expired",
      }),
    ]);
  });

  test("cancels a deleted trigger but ignores later role and Enrollment changes", async () => {
    const database = createTestDb();
    const first = queuedDelivery(database);
    const second = addLaterDelivery(
      database,
      first,
      "2026-01-01T00:00:01.000Z"
    );
    database
      .update(comments)
      .set({ deletedAt: "2026-01-01T00:00:02.000Z" })
      .where(eq(comments.id, first.payload.sourceCommentId))
      .run();
    database
      .update(users)
      .set({ role: UserRole.Instructor })
      .where(eq(users.id, first.actorId))
      .run();
    database
      .delete(enrollments)
      .where(eq(enrollments.userId, first.actorId))
      .run();
    const provider = new FakeKnockAdapter();

    await createNotificationDispatcher({
      database,
      provider,
      concurrency: 2,
      now: () => new Date("2026-01-01T00:00:03.000Z"),
    }).runOnce();

    expect(deliveryRow(database, first.delivery.id)?.status).toBe("cancelled");
    expect(deliveryRow(database, second.id)?.status).toBe("accepted");
  });

  test("cancels when the captured recipient account no longer exists", async () => {
    const database = createTestDb();
    const queued = queuedDelivery(database);
    database.run(sql.raw("PRAGMA foreign_keys = OFF"));
    database
      .update(notificationDeliveries)
      .set({ recipientId: 999_999 })
      .where(eq(notificationDeliveries.id, queued.delivery.id))
      .run();
    database.run(sql.raw("PRAGMA foreign_keys = ON"));
    const provider = { trigger: vi.fn() };

    await createNotificationDispatcher({
      database,
      provider,
      now: () => new Date("2026-01-01T00:00:01.000Z"),
    }).runOnce();

    expect(provider.trigger).not.toHaveBeenCalled();
    expect(deliveryRow(database, queued.delivery.id)?.status).toBe("cancelled");
  });

  test("lets a later Delivery proceed while an older Delivery is failing", async () => {
    const database = createTestDb();
    const first = queuedDelivery(database);
    const second = addLaterDelivery(
      database,
      first,
      "2026-01-01T00:00:01.000Z"
    );
    const attempted: string[] = [];
    const provider = {
      trigger(idempotencyKey: string, _payload: NotificationPayload) {
        attempted.push(idempotencyKey);
        if (idempotencyKey === first.delivery.idempotencyKey) {
          throw new TypeError("offline");
        }
      },
    };

    await createNotificationDispatcher({
      database,
      provider,
      concurrency: 2,
      now: () => new Date("2026-01-01T00:00:02.000Z"),
    }).runOnce();

    expect(attempted).toEqual([
      first.delivery.idempotencyKey,
      second.idempotencyKey,
    ]);
    expect(deliveryRow(database, first.delivery.id)?.status).toBe(
      "outcome_unknown"
    );
    expect(deliveryRow(database, second.id)?.status).toBe("accepted");
  });

  test("stops new claims during graceful shutdown and waits for in-flight work", async () => {
    const database = createTestDb();
    const first = queuedDelivery(database);
    const second = addLaterDelivery(
      database,
      first,
      "2026-01-01T00:00:01.000Z"
    );
    let release: (() => void) | undefined;
    const provider = {
      trigger: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          })
      ),
    };
    const dispatcher = createNotificationDispatcher({
      database,
      provider,
      concurrency: 1,
      now: () => new Date("2026-01-01T00:00:02.000Z"),
    });
    dispatcher.start();
    await Promise.resolve();
    await Promise.resolve();

    const stopping = dispatcher.stop();
    expect(provider.trigger).toHaveBeenCalledTimes(1);
    expect(deliveryRow(database, second.id)?.status).toBe("queued");
    release?.();
    await stopping;
    expect(deliveryRow(database, first.delivery.id)?.status).toBe("accepted");
  });
});
