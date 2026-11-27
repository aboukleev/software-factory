import { eq } from "drizzle-orm";
import { describe, expect, test, vi } from "vitest";
import {
  enrollments,
  lessons,
  modules,
  notificationDeliveries,
  notificationDeliveryIncidents,
  notificationDeliveryTransitions,
} from "~/db/schema";
import { createDiscussionPost } from "~/services/discussionService";
import {
  createNotificationOperations,
  notificationOperationalObjectives,
} from "~/services/notificationOperations.server";
import { createTestDb, seedBaseData } from "~/test/setup";

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined)
    throw new Error("Expected test fixture value");
  return value;
}

function fixture() {
  const database = createTestDb();
  const { user, course } = seedBaseData(database);
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
  return { database, user, course, lesson };
}

describe("Notification operations", () => {
  test("defaults to the dark-deploy control state before an operator enables launch", () => {
    const { database } = fixture();
    const operations = createNotificationOperations({ database });

    expect(operations.getControls()).toEqual({
      creationEnabled: false,
      dispatchEnabled: true,
      feedEnabled: false,
      updatedAt: null,
    });
  });

  test("changes independent durable controls without redeployment", () => {
    const { database } = fixture();
    const operations = createNotificationOperations({
      database,
      now: () => new Date("2026-11-26T12:00:00.000Z"),
    });

    operations.setControls({ creationEnabled: false });
    expect(operations.getControls()).toEqual({
      creationEnabled: false,
      dispatchEnabled: true,
      feedEnabled: false,
      updatedAt: "2026-11-26T12:00:00.000Z",
    });

    operations.setControls({ dispatchEnabled: false });
    operations.setControls({ feedEnabled: false });
    expect(operations.getControls()).toMatchObject({
      creationEnabled: false,
      dispatchEnabled: false,
      feedEnabled: false,
    });
  });

  test("records content-free transitions and derives backlog metrics", () => {
    const { database, user, course, lesson } = fixture();
    createDiscussionPost(
      {
        authorization: { userId: user.id, courseId: course.id },
        lessonId: lesson.id,
        parentId: null,
        body: "Sensitive question text",
      },
      database,
      vi.fn()
    );
    const delivery = required(
      database.select().from(notificationDeliveries).get()
    );
    database
      .update(notificationDeliveries)
      .set({ nextAttemptAt: "2026-11-26T12:00:00.000Z" })
      .where(eq(notificationDeliveries.id, delivery.id))
      .run();
    const logs: unknown[] = [];
    const operations = createNotificationOperations({
      database,
      now: () => new Date("2026-11-26T12:06:00.000Z"),
      log: (entry) => logs.push(entry),
    });

    operations.recordTransition(
      delivery.id,
      "queued",
      "attempting",
      "first_attempt"
    );
    operations.recordHeartbeat();
    const snapshot = operations.snapshot();

    expect(snapshot.backlog).toEqual({
      due: 1,
      inFlight: 0,
      oldestDueAgeMs: expect.any(Number),
    });
    expect(snapshot.alerts).toContain("oldest_due_over_five_minutes");
    expect(snapshot.objectives).toEqual(notificationOperationalObjectives);
    expect(snapshot.metrics.attemptsByCategory).toMatchObject({
      first_attempt: 1,
      retry_attempt: 0,
      expired_lease_recovered: 0,
    });
    const transitions = database
      .select()
      .from(notificationDeliveryTransitions)
      .where(eq(notificationDeliveryTransitions.deliveryId, delivery.id))
      .all();
    expect(transitions).toHaveLength(2);
    const evidence = JSON.stringify({ logs, transitions });
    expect(evidence).not.toContain("Sensitive question text");
    expect(evidence).not.toContain(user.email);
    expect(logs).toEqual([
      expect.objectContaining({
        type: "notification_delivery_transition",
        deliveryId: delivery.id,
        notificationEventId: delivery.notificationEventId,
        outcomeCode: "first_attempt",
      }),
    ]);
  });

  test("reports latency, unresolved work, incidents, and actionable alerts", () => {
    const { database, user, course, lesson } = fixture();
    for (let index = 0; index < 3; index += 1) {
      createDiscussionPost(
        {
          authorization: { userId: user.id, courseId: course.id },
          lessonId: lesson.id,
          parentId: null,
          body: `Private question ${index}`,
        },
        database,
        vi.fn()
      );
    }
    const deliveries = database.select().from(notificationDeliveries).all();
    database
      .update(notificationDeliveries)
      .set({
        status: "accepted",
        firstAttemptAt: "2026-11-26T12:00:20.000Z",
        acceptedAt: "2026-11-26T12:00:30.000Z",
      })
      .where(eq(notificationDeliveries.id, deliveries[0].id))
      .run();
    database
      .update(notificationDeliveries)
      .set({
        status: "outcome_unknown",
        acceptedAt: "2026-11-26T12:00:00.000Z",
        errorCategory: "provider_outcome_ambiguous",
      })
      .where(eq(notificationDeliveries.id, deliveries[1].id))
      .run();
    database
      .update(notificationDeliveries)
      .set({
        status: "permanently_failed",
        errorCategory: "provider_permanent",
      })
      .where(eq(notificationDeliveries.id, deliveries[2].id))
      .run();
    database
      .insert(notificationDeliveryIncidents)
      .values({
        deliveryId: deliveries[1].id,
        providerEventId: "evt_duplicate",
        kind: "physical_duplicate",
        evidence: JSON.stringify({ messageIds: ["msg_one", "msg_two"] }),
      })
      .run();

    const snapshot = createNotificationOperations({
      database,
      now: () => new Date("2026-11-26T12:06:00.000Z"),
    }).snapshot();

    expect(snapshot.metrics).toMatchObject({
      unresolvedAccepted: 2,
      permanentFailures: 1,
      unknownOutcomes: 1,
      confirmedDuplicates: 1,
      acceptedLatency: { count: 2, maximumMs: expect.any(Number) },
      deliveredLatency: { count: 0, averageMs: null, maximumMs: null },
    });
    expect(snapshot.alerts).toEqual(
      expect.arrayContaining([
        "dispatcher_heartbeat_missing",
        "acceptance_unresolved_over_five_minutes",
        "permanent_configuration_or_authentication_failure",
        "unknown_outcome",
        "confirmed_duplicate",
      ])
    );
    expect(JSON.stringify(snapshot)).not.toContain("Private question");
  });
});
