import { describe, expect, test } from "vitest";
import { FakeKnockAdapter } from "~/services/notificationProvider";
import { createNotificationReadService } from "~/services/notificationReadService";

function addNotification(
  provider: FakeKnockAdapter,
  id: string,
  recipientId: number
) {
  provider.trigger(id, {
    eventIdentity: `question.created:${id}`,
    eventKind: "question.created",
    occurredAt: "2026-11-23T12:00:00.000Z",
    sourceCommentId: 42,
    rootQuestionId: 42,
    recipientId,
    courseId: 3,
    lessonId: 9,
  });
}

describe("Notification read service", () => {
  test("acknowledges one Notification without changing another recipient", async () => {
    const provider = new FakeKnockAdapter();
    const service = createNotificationReadService(provider);
    addNotification(provider, "for-seven", 7);
    addNotification(provider, "for-eight", 8);

    await expect(service.markRead(7, "for-seven")).resolves.toEqual({
      ok: true,
    });
    expect(provider.list(7)[0]?.readAt).not.toBeNull();
    expect(provider.list(8)[0]?.readAt).toBeNull();
    await expect(service.markRead(8, "for-seven")).resolves.toEqual({
      ok: false,
      reason: "provider-rejected",
    });
  });

  test("reports mutation failure so callers can reconcile without throwing", async () => {
    const provider = new FakeKnockAdapter();
    const service = createNotificationReadService(provider);
    addNotification(provider, "one", 7);
    provider.failNextRead();

    await expect(service.markRead(7, "one")).resolves.toEqual({
      ok: false,
      reason: "provider-rejected",
    });
    expect(provider.list(7)[0]?.readAt).toBeNull();
  });

  test("Mark all read delegates to provider authority rather than loaded items", async () => {
    const provider = new FakeKnockAdapter();
    const service = createNotificationReadService(provider);
    addNotification(provider, "visible", 7);
    addNotification(provider, "unloaded", 7);

    await expect(service.markAllRead(7)).resolves.toEqual({ ok: true });
    expect(provider.list(7).every((item) => item.readAt !== null)).toBe(true);

    addNotification(provider, "later", 7);
    expect(
      provider.list(7).find((item) => item.id === "later")?.readAt
    ).toBeNull();
  });
});
