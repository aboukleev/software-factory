import { describe, expect, test, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  comments,
  enrollments,
  lessons,
  modules,
  notificationDeliveries,
  notificationDeliveryIncidents,
  notificationEvents,
} from "~/db/schema";
import { createDiscussionPost } from "~/services/discussionService";
import { createNotificationDispatcher } from "~/services/notificationDispatcher.server";
import {
  createNotificationLifecycleService,
  notificationRetentionPolicy,
} from "~/services/notificationLifecycle.server";
import { FakeKnockAdapter } from "~/services/notificationProvider";
import { createTestDb, seedBaseData } from "~/test/setup";

function fixture(occurredAt = "2026-01-01T00:00:00.000Z") {
  const database = createTestDb();
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
  const post = createDiscussionPost(
    {
      authorization: { userId: user.id, courseId: course.id },
      lessonId: lesson.id,
      parentId: null,
      body: "How long is a Notification retained?",
    },
    database,
    () => undefined
  );
  const event = database.select().from(notificationEvents).get()!;
  const delivery = database.select().from(notificationDeliveries).get()!;
  database
    .update(comments)
    .set({ createdAt: occurredAt })
    .where(eq(comments.id, post.source.id))
    .run();
  database
    .update(notificationEvents)
    .set({ occurredAt })
    .where(eq(notificationEvents.id, event.id))
    .run();
  database
    .update(notificationDeliveries)
    .set({
      nextAttemptAt: occurredAt,
      providerPayload: JSON.stringify({
        ...JSON.parse(delivery.providerPayload),
        occurredAt,
      }),
    })
    .where(eq(notificationDeliveries.id, delivery.id))
    .run();
  return {
    database,
    provider: new FakeKnockAdapter(),
    recipientId: instructor.id,
    actorId: user.id,
    eventId: event.id,
    deliveryId: delivery.id,
  };
}

describe("Notification lifecycle", () => {
  test("permanently removes a Notification at exactly 90 days from Event occurrence", async () => {
    const f = fixture();
    await createNotificationDispatcher({
      database: f.database,
      provider: f.provider,
      now: () => new Date("2026-01-01T00:00:01.000Z"),
    }).runOnce();

    expect(
      await createNotificationLifecycleService({
        database: f.database,
        provider: f.provider,
        now: () => new Date("2026-04-01T00:00:00.000Z"),
      }).expireNotifications()
    ).toEqual({ expired: 1, blocked: 0 });
    expect(f.provider.list(f.recipientId)).toEqual([]);
    expect(f.database.select().from(notificationEvents).all()).toEqual([]);
    expect(f.database.select().from(notificationDeliveries).all()).toEqual([]);
  });

  test("does not extend lifetime when a Notification is read or authorization changes", async () => {
    const f = fixture();
    await createNotificationDispatcher({
      database: f.database,
      provider: f.provider,
      now: () => new Date("2026-01-01T00:00:01.000Z"),
    }).runOnce();
    f.provider.markRead(f.recipientId, f.provider.list(f.recipientId)[0]!.id);
    f.database
      .delete(enrollments)
      .where(eq(enrollments.userId, f.actorId))
      .run();

    expect(
      await createNotificationLifecycleService({
        database: f.database,
        provider: f.provider,
        now: () => new Date("2026-03-31T23:59:59.999Z"),
      }).expireNotifications()
    ).toEqual({ expired: 0, blocked: 0 });
    expect(f.provider.list(f.recipientId)).toHaveLength(1);
  });

  test("deletes terminal operational records 90 days after terminal state", () => {
    const f = fixture();
    f.database
      .update(notificationDeliveries)
      .set({ status: "cancelled", terminalAt: "2026-01-02T00:00:00.000Z" })
      .where(eq(notificationDeliveries.id, f.deliveryId))
      .run();
    const lifecycle = createNotificationLifecycleService({
      database: f.database,
      provider: f.provider,
      now: () => new Date("2026-04-02T00:00:00.000Z"),
    });

    expect(lifecycle.cleanupTerminalRecords()).toBe(1);
    expect(f.database.select().from(notificationDeliveries).all()).toEqual([]);
    expect(f.database.select().from(notificationEvents).all()).toEqual([]);
  });

  test("does not claim provider erasure for a Notification never accepted by the provider", async () => {
    const f = fixture();
    f.database
      .update(notificationDeliveries)
      .set({
        status: "cancelled",
        terminalAt: "2026-03-31T23:59:59.000Z",
      })
      .where(eq(notificationDeliveries.id, f.deliveryId))
      .run();

    expect(
      await createNotificationLifecycleService({
        database: f.database,
        provider: f.provider,
        now: () => new Date("2026-04-01T00:00:00.000Z"),
      }).expireNotifications()
    ).toEqual({ expired: 0, blocked: 0 });
    expect(
      f.database.select().from(notificationDeliveryIncidents).all()
    ).toEqual([]);
  });

  test("retains delivered records needed to retry blocked provider erasure", () => {
    const f = fixture();
    f.database
      .update(notificationDeliveries)
      .set({
        status: "delivered",
        terminalAt: "2026-01-02T00:00:00.000Z",
      })
      .where(eq(notificationDeliveries.id, f.deliveryId))
      .run();

    expect(
      createNotificationLifecycleService({
        database: f.database,
        provider: f.provider,
        now: () => new Date("2026-04-02T00:00:00.000Z"),
      }).cleanupTerminalRecords()
    ).toBe(0);
    expect(f.database.select().from(notificationDeliveries).all()).toHaveLength(
      1
    );
  });

  test("hard-deletes the Knock User and removes identifying dispatch data on account erasure", async () => {
    const f = fixture();
    await createNotificationDispatcher({
      database: f.database,
      provider: f.provider,
      now: () => new Date("2026-01-01T00:00:01.000Z"),
    }).runOnce();
    const deleteUser = vi.spyOn(f.provider, "deleteUser");

    await createNotificationLifecycleService({
      database: f.database,
      provider: f.provider,
    }).eraseAccount(f.recipientId);

    expect(deleteUser).toHaveBeenCalledWith(f.recipientId);
    expect(f.provider.list(f.recipientId)).toEqual([]);
    expect(f.database.select().from(notificationDeliveries).all()).toEqual([]);
    expect(f.database.select().from(notificationEvents).all()).toEqual([]);
  });

  test("anonymizes an erased actor while retaining the recipient Notification for normal expiry", async () => {
    const f = fixture();
    await createNotificationDispatcher({
      database: f.database,
      provider: f.provider,
      now: () => new Date("2026-01-01T00:00:01.000Z"),
    }).runOnce();

    await createNotificationLifecycleService({
      database: f.database,
      provider: f.provider,
    }).eraseAccount(f.actorId);

    expect(f.provider.list(f.recipientId)).toHaveLength(1);
    expect(f.database.select().from(notificationEvents).get()).toMatchObject({
      actorId: null,
    });
    expect(f.database.select().from(notificationDeliveries).all()).toHaveLength(
      1
    );
  });

  test("archives incorrect Notifications only for containment and records an incident", async () => {
    const f = fixture();
    await createNotificationDispatcher({
      database: f.database,
      provider: f.provider,
      now: () => new Date("2026-01-01T00:00:01.000Z"),
    }).runOnce();
    const messageId = f.provider.list(f.recipientId)[0]!.id;

    await createNotificationLifecycleService({
      database: f.database,
      provider: f.provider,
    }).containIncorrectNotification({
      deliveryId: f.deliveryId,
      messageId,
      classification: "privacy",
      evidence: "authorization_context_incorrect",
    });

    expect(f.provider.list(f.recipientId)).toEqual([]);
    expect(f.provider.listArchived(f.recipientId)).toHaveLength(1);
    expect(
      f.database.select().from(notificationDeliveryIncidents).all()
    ).toEqual([
      expect.objectContaining({
        deliveryId: f.deliveryId,
        kind: "privacy",
        evidence: JSON.stringify({
          reason: "authorization_context_incorrect",
          containment: "archive",
          permanentErasure: false,
          releaseBlocked: true,
        }),
      }),
    ]);
    expect(f.database.select().from(notificationDeliveries).all()).toHaveLength(
      1
    );
  });

  test("records a release-blocking incident when archive containment fails", async () => {
    const f = fixture();
    await createNotificationDispatcher({
      database: f.database,
      provider: f.provider,
      now: () => new Date("2026-01-01T00:00:01.000Z"),
    }).runOnce();
    const messageId = f.provider.list(f.recipientId)[0]!.id;
    f.provider.archiveNotification = () => {
      throw new Error("provider unavailable");
    };

    await expect(
      createNotificationLifecycleService({
        database: f.database,
        provider: f.provider,
      }).containIncorrectNotification({
        deliveryId: f.deliveryId,
        messageId,
        classification: "privacy",
        evidence: "authorization_context_incorrect",
      })
    ).rejects.toThrow("provider unavailable");
    expect(
      f.database.select().from(notificationDeliveryIncidents).get()
    ).toMatchObject({
      kind: "privacy",
      evidence: JSON.stringify({
        reason: "authorization_context_incorrect",
        containment: "archive",
        outcome: "failed",
        permanentErasure: false,
        releaseBlocked: true,
      }),
    });
  });

  test("reports provider erasure gaps instead of treating archive as permanent deletion", async () => {
    const f = fixture();
    await createNotificationDispatcher({
      database: f.database,
      provider: f.provider,
      now: () => new Date("2026-01-01T00:00:01.000Z"),
    }).runOnce();
    f.provider.disablePermanentMessageDeletion();

    expect(
      await createNotificationLifecycleService({
        database: f.database,
        provider: f.provider,
        now: () => new Date("2026-04-01T00:00:00.000Z"),
      }).expireNotifications()
    ).toEqual({ expired: 0, blocked: 1 });
    expect(f.provider.list(f.recipientId)).toHaveLength(1);
    expect(f.database.select().from(notificationEvents).all()).toHaveLength(1);
    expect(
      f.database.select().from(notificationDeliveryIncidents).all()
    ).toEqual([
      expect.objectContaining({
        kind: "privacy",
        evidence: JSON.stringify({
          operation: "per_message_permanent_deletion",
          outcome: "unsupported",
          archiveIsDeletion: false,
          releaseBlocked: true,
        }),
      }),
    ]);
  });
});

test("retention policy is anchored to exact elapsed time", () => {
  expect(notificationRetentionPolicy.visibleLifetimeMs).toBe(
    90 * 24 * 60 * 60 * 1_000
  );
});
