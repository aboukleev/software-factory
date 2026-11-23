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
    occurredAt: "2026-11-23T12:00:00.000Z",
    sourceCommentId: 42,
    rootQuestionId: 42,
    recipientId,
    courseId: 3,
    lessonId: 9,
  });
}

describe("Notification read service", () => {
  test("acknowledges one Notification without changing another recipient", () => {
    const provider = new FakeKnockAdapter();
    const service = createNotificationReadService(provider);
    addNotification(provider, "for-seven", 7);
    addNotification(provider, "for-eight", 8);

    expect(service.markRead(7, "for-seven")).toEqual({ ok: true });
    expect(provider.list(7)[0]?.readAt).not.toBeNull();
    expect(provider.list(8)[0]?.readAt).toBeNull();
    expect(service.markRead(8, "for-seven")).toEqual({
      ok: false,
      reason: "provider-rejected",
    });
  });

  test("reports mutation failure so callers can reconcile without throwing", () => {
    const provider = new FakeKnockAdapter();
    const service = createNotificationReadService(provider);
    addNotification(provider, "one", 7);
    provider.failNextRead();

    expect(service.markRead(7, "one")).toEqual({
      ok: false,
      reason: "provider-rejected",
    });
    expect(provider.list(7)[0]?.readAt).toBeNull();
  });

  test("Mark all read delegates to provider authority rather than loaded items", () => {
    const provider = new FakeKnockAdapter();
    const service = createNotificationReadService(provider);
    addNotification(provider, "visible", 7);
    addNotification(provider, "unloaded", 7);

    expect(service.markAllRead(7)).toEqual({ ok: true });
    expect(provider.list(7).every((item) => item.readAt !== null)).toBe(true);

    addNotification(provider, "later", 7);
    expect(
      provider.list(7).find((item) => item.id === "later")?.readAt
    ).toBeNull();
  });
});
