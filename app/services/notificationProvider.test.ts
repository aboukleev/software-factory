import { describe, expect, test } from "vitest";
import { FakeKnockAdapter } from "~/services/notificationProvider";

describe("FakeKnockAdapter", () => {
  test("only the recipient can list or mark a Notification read", () => {
    const provider = new FakeKnockAdapter();
    provider.trigger("event:recipient:in_app", {
      eventIdentity: "question.created:42",
      eventKind: "question.created",
      actorCapacity: "student",
      occurredAt: "2026-11-23T12:00:00.000Z",
      sourceCommentId: 42,
      rootQuestionId: 42,
      recipientId: 7,
      courseId: 3,
      lessonId: 9,
    });

    expect(provider.list(8)).toEqual([]);
    expect(provider.markRead(8, "event:recipient:in_app")).toBe(false);
    expect(provider.list(7)[0]?.readAt).toBeNull();

    expect(provider.markRead(7, "event:recipient:in_app")).toBe(true);
    expect(provider.list(7)[0]?.readAt).not.toBeNull();
  });

  test("reusing an idempotency identity stores one Notification", () => {
    const provider = new FakeKnockAdapter();
    const payload = {
      eventIdentity: "question.created:42",
      eventKind: "question.created" as const,
      actorCapacity: "student" as const,
      occurredAt: "2026-11-23T12:00:00.000Z",
      sourceCommentId: 42,
      rootQuestionId: 42,
      recipientId: 7,
      courseId: 3,
      lessonId: 9,
    };

    provider.trigger("event:recipient:in_app", payload);
    provider.trigger("event:recipient:in_app", payload);

    expect(provider.list(7)).toHaveLength(1);
  });
});
