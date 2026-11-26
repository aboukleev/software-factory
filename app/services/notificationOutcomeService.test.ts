import { createHmac } from "node:crypto";
import { describe, expect, test, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  comments,
  enrollments,
  lessons,
  modules,
  notificationDeliveries,
  notificationDeliveryIncidents,
  notificationOutcomeEvents,
  notificationEvents,
} from "~/db/schema";
import {
  createNotificationOutcomeService,
  deliveryTransitions,
  verifyKnockWebhookSignature,
} from "~/services/notificationOutcomeService.server";
import { createNotificationDispatcher } from "~/services/notificationDispatcher.server";
import { FakeKnockAdapter } from "~/services/notificationProvider";
import { createTestDb, seedBaseData } from "~/test/setup";

function fixture(
  status: typeof notificationDeliveries.$inferInsert.status = "accepted"
) {
  const database = createTestDb();
  const { user, instructor, course } = seedBaseData(database);
  database
    .insert(enrollments)
    .values({ userId: user.id, courseId: course.id })
    .run();
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
  const source = database
    .insert(comments)
    .values({
      userId: user.id,
      lessonId: lesson.id,
      parentId: null,
      body: "Will this reconcile?",
      createdAt: "2026-01-01T00:00:00.000Z",
    })
    .returning()
    .get();
  const event = database
    .insert(notificationEvents)
    .values({
      identity: `question.created:${source.id}`,
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
  const delivery = database
    .insert(notificationDeliveries)
    .values({
      notificationEventId: event.id,
      recipientId: instructor.id,
      channel: "in_app",
      workflowKey: "student-question-created",
      idempotencyKey: `${event.identity}:${instructor.id}:in_app`,
      providerPayload: JSON.stringify({
        eventIdentity: event.identity,
        eventKind: event.kind,
        occurredAt: event.occurredAt,
        sourceCommentId: event.sourceCommentId,
        rootQuestionId: event.rootQuestionId,
        recipientId: event.recipientId,
        courseId: event.courseId,
        lessonId: event.lessonId,
      }),
      status,
      nextAttemptAt: source.createdAt,
      acceptedAt: status === "accepted" ? "2026-01-01T00:00:01.000Z" : null,
      providerWorkflowRunId: "run_123",
      providerRequestId: "req_123",
    })
    .returning()
    .get();
  return { database, delivery, event };
}

function row(f: ReturnType<typeof fixture>) {
  return f.database
    .select()
    .from(notificationDeliveries)
    .where(eq(notificationDeliveries.id, f.delivery.id))
    .get()!;
}

describe("Delivery outcome state machine", () => {
  test("declares every valid Delivery transition", () => {
    expect(deliveryTransitions).toEqual({
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
    });
  });

  test("service-applies every valid Delivery transition", () => {
    for (const [current, nextStatuses] of Object.entries(deliveryTransitions)) {
      for (const next of nextStatuses) {
        const f = fixture(current as Parameters<typeof fixture>[0]);
        const service = createNotificationOutcomeService({
          database: f.database,
          provider: {},
        });

        expect(service.transition(f.delivery.id, next, {}).status).toBe(next);
      }
    }
  });

  test("service-rejects every undeclared Delivery transition", () => {
    const statuses = Object.keys(deliveryTransitions) as Array<
      keyof typeof deliveryTransitions
    >;
    for (const current of statuses) {
      for (const next of statuses) {
        if (deliveryTransitions[current].includes(next as never)) continue;
        const f = fixture(current);
        const service = createNotificationOutcomeService({
          database: f.database,
          provider: {},
        });

        expect(() => service.transition(f.delivery.id, next, {})).toThrow(
          `Invalid Delivery transition ${current} -> ${next}`
        );
        expect(row(f).status).toBe(current);
      }
    }
  });

  test("rejects an invalid transition without changing durable state", () => {
    const f = fixture("accepted");
    const service = createNotificationOutcomeService({
      database: f.database,
      provider: {},
    });

    expect(() =>
      service.transition(f.delivery.id, "retry_scheduled", {})
    ).toThrow("Invalid Delivery transition accepted -> retry_scheduled");
    expect(row(f).status).toBe("accepted");
  });

  test("reconciles provider acceptance to confirmed in-app Delivery", async () => {
    const f = fixture();
    const provider = {
      lookupOutcome: vi.fn().mockResolvedValue({
        kind: "delivered",
        messageIds: ["msg_123"],
        occurredAt: "2026-01-01T00:00:02.000Z",
      }),
    };

    await createNotificationOutcomeService({
      database: f.database,
      provider,
      now: () => new Date("2026-01-01T00:01:00.000Z"),
    }).reconcileAccepted();

    expect(provider.lookupOutcome).toHaveBeenCalledWith(
      "run_123",
      f.delivery.idempotencyKey
    );
    expect(row(f)).toMatchObject({
      status: "delivered",
      providerMessageId: "msg_123",
      deliveredAt: "2026-01-01T00:00:02.000Z",
    });
  });

  test("keeps provider acceptance distinct from fake Feed storage confirmation", async () => {
    const f = fixture("queued");
    f.database
      .update(notificationDeliveries)
      .set({ providerRequestId: null, providerWorkflowRunId: null })
      .where(eq(notificationDeliveries.id, f.delivery.id))
      .run();
    const provider = new FakeKnockAdapter();
    await createNotificationDispatcher({
      database: f.database,
      provider,
      now: () => new Date("2026-01-01T00:00:01.000Z"),
    }).runOnce();

    expect(row(f)).toMatchObject({
      status: "accepted",
      providerRequestId: `fake-request:${f.delivery.idempotencyKey}`,
      providerWorkflowRunId: `fake-run:${f.delivery.idempotencyKey}`,
      deliveredAt: null,
    });

    await createNotificationOutcomeService({
      database: f.database,
      provider,
      now: () => new Date("2026-01-01T00:00:02.000Z"),
    }).reconcileAccepted();
    expect(row(f)).toMatchObject({
      status: "delivered",
      providerMessageId: f.delivery.idempotencyKey,
      deliveredAt: "2026-01-01T00:00:00.000Z",
    });
  });

  test("treats an eligible workflow skip as permanent failure", () => {
    const f = fixture();
    const service = createNotificationOutcomeService({
      database: f.database,
      provider: {},
    });

    service.recordOutcome({
      providerEventId: "evt_skip",
      workflowRunId: "run_123",
      kind: "skipped",
      occurredAt: "2026-01-01T00:00:02.000Z",
    });

    expect(row(f)).toMatchObject({
      status: "permanently_failed",
      errorCategory: "provider_workflow_skipped",
    });
  });

  test("periodically revisits unresolved acceptance without reissuing it", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      const provider = {
        lookupOutcome: vi
          .fn()
          .mockResolvedValueOnce({ kind: "pending" })
          .mockResolvedValueOnce({
            kind: "delivered",
            messageIds: ["msg_later"],
            occurredAt: "2026-01-01T00:02:00.000Z",
          }),
      };
      let current = new Date("2026-01-01T00:01:00.000Z");
      const service = createNotificationOutcomeService({
        database: f.database,
        provider,
        now: () => current,
      });
      const stop = service.startPeriodicReconciliation(60_000);

      await vi.advanceTimersByTimeAsync(60_000);
      expect(row(f)).toMatchObject({
        status: "accepted",
        outcomeNextCheckAt: "2026-01-01T00:02:00.000Z",
      });
      current = new Date("2026-01-01T00:02:00.000Z");
      await vi.advanceTimersByTimeAsync(60_000);
      expect(row(f)).toMatchObject({
        status: "delivered",
        providerMessageId: "msg_later",
      });
      expect(provider.lookupOutcome).toHaveBeenCalledTimes(2);
      await stop();
    } finally {
      vi.useRealTimers();
    }
  });

  test("keeps an ambiguous outcome unresolved and never queues a blind reissue", async () => {
    const f = fixture();
    await createNotificationOutcomeService({
      database: f.database,
      provider: {
        lookupOutcome: vi.fn().mockResolvedValue({ kind: "unknown" }),
      },
      now: () => new Date("2026-01-01T00:01:00.000Z"),
    }).reconcileAccepted();

    expect(row(f)).toMatchObject({
      status: "outcome_unknown",
      errorCategory: "provider_outcome_ambiguous",
    });
  });

  test("handles an outcome event idempotently and records a physical duplicate as an incident", () => {
    const f = fixture();
    const service = createNotificationOutcomeService({
      database: f.database,
      provider: {},
    });
    const first = {
      providerEventId: "evt_delivered",
      workflowRunId: "run_123",
      kind: "delivered" as const,
      providerMessageIds: ["msg_one"],
      occurredAt: "2026-01-01T00:00:02.000Z",
    };

    expect(service.recordOutcome(first)).toEqual({ applied: true });
    expect(service.recordOutcome(first)).toEqual({
      applied: false,
      reason: "duplicate_event",
    });
    expect(
      f.database.select().from(notificationOutcomeEvents).all()
    ).toHaveLength(1);

    service.recordOutcome({
      ...first,
      providerEventId: "evt_duplicate",
      providerMessageIds: ["msg_one", "msg_two"],
    });
    expect(
      f.database.select().from(notificationDeliveryIncidents).all()
    ).toEqual([
      expect.objectContaining({
        deliveryId: f.delivery.id,
        kind: "physical_duplicate",
      }),
    ]);
    expect(row(f).status).toBe("delivered");
  });

  test("records an initially confirmed physical duplicate as an incident, not success", async () => {
    const f = fixture();
    await createNotificationOutcomeService({
      database: f.database,
      provider: {
        lookupOutcome: vi.fn().mockResolvedValue({
          kind: "unknown",
          messageIds: ["msg_two", "msg_one"],
        }),
      },
      now: () => new Date("2026-01-01T00:01:00.000Z"),
    }).reconcileAccepted();

    expect(row(f)).toMatchObject({
      status: "outcome_unknown",
      errorCategory: "provider_physical_duplicate",
      outcomeNextCheckAt: null,
    });
    expect(
      f.database.select().from(notificationDeliveryIncidents).all()
    ).toEqual([
      expect.objectContaining({
        deliveryId: f.delivery.id,
        kind: "physical_duplicate",
        evidence: JSON.stringify({ messageIds: ["msg_one", "msg_two"] }),
      }),
    ]);
  });

  test("manual recovery enforces age and evidence rules while preserving identity", () => {
    const f = fixture("outcome_unknown");
    const before = row(f);
    const service = createNotificationOutcomeService({
      database: f.database,
      provider: {},
      now: () => new Date("2026-01-01T12:00:00.000Z"),
    });

    expect(() => service.requeue(f.delivery.id)).toThrow(
      "provider evidence of no Notification is required"
    );
    service.confirmNoNotification(f.delivery.id, "operator_knock_log_review");
    service.requeue(f.delivery.id);
    expect(row(f)).toMatchObject({
      status: "queued",
      idempotencyKey: before.idempotencyKey,
      providerPayload: before.providerPayload,
      notificationEventId: before.notificationEventId,
      providerRequestId: before.providerRequestId,
      providerWorkflowRunId: before.providerWorkflowRunId,
    });

    const old = fixture("permanently_failed");
    expect(() =>
      createNotificationOutcomeService({
        database: old.database,
        provider: {},
        now: () => new Date("2026-01-02T00:00:00.000Z"),
      }).requeue(old.delivery.id)
    ).toThrow("24-hour recovery window has expired");
  });

  test("permits evidence-free recovery of a recent permanent failure", () => {
    const f = fixture("permanently_failed");
    const before = row(f);
    createNotificationOutcomeService({
      database: f.database,
      provider: {},
      now: () => new Date("2026-01-01T23:59:59.999Z"),
    }).requeue(f.delivery.id);

    expect(row(f)).toMatchObject({
      status: "queued",
      idempotencyKey: before.idempotencyKey,
      providerPayload: before.providerPayload,
    });
  });
});

describe("Knock outcome authentication", () => {
  test("accepts only a current HMAC signature over the exact body", () => {
    const body = JSON.stringify({ type: "message.delivered" });
    const timestamp = "1767225600000";
    const signature = createHmac("sha256", "secret")
      .update(`${timestamp}.${body}`)
      .digest("base64");

    expect(
      verifyKnockWebhookSignature(
        body,
        `t=${timestamp},s=${signature}`,
        "secret",
        new Date("2026-01-01T00:00:00.000Z")
      )
    ).toBe(true);
    expect(
      verifyKnockWebhookSignature(
        `${body} `,
        `t=${timestamp},s=${signature}`,
        "secret",
        new Date("2026-01-01T00:00:00.000Z")
      )
    ).toBe(false);
  });
});
