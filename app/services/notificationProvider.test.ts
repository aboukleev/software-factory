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

  test("listing and paging Notifications never changes their unread state", () => {
    const provider = new FakeKnockAdapter();
    for (const [id, occurredAt] of [
      ["old", "2026-11-23T10:00:00.000Z"],
      ["new", "2026-11-23T12:00:00.000Z"],
    ] as const) {
      provider.trigger(id, {
        eventIdentity: `question.created:${id}`,
        eventKind: "question.created",
        actorCapacity: "student",
        occurredAt,
        sourceCommentId: id === "old" ? 41 : 42,
        rootQuestionId: id === "old" ? 41 : 42,
        recipientId: 7,
        courseId: 3,
        lessonId: 9,
      });
    }

    expect(provider.listPage(7, { pageSize: 1 })).toMatchObject({
      items: [{ id: "new", readAt: null }],
      unreadCount: 2,
      nextCursor: "1",
    });
    expect(provider.listPage(7, { pageSize: 1, cursor: "1" })).toMatchObject({
      items: [{ id: "old", readAt: null }],
      unreadCount: 2,
      nextCursor: null,
    });
  });

  test("provider order is authoritative even when a delayed Notification has an older occurrence time", () => {
    const provider = new FakeKnockAdapter();
    const notification = (id: number, occurredAt: string) => ({
      eventIdentity: `question.created:${id}`,
      eventKind: "question.created" as const,
      actorCapacity: "student" as const,
      occurredAt,
      sourceCommentId: id,
      rootQuestionId: id,
      recipientId: 7,
      courseId: 3,
      lessonId: 9,
    });

    provider.trigger(
      "already-present",
      notification(1, "2026-11-23T12:00:00.000Z")
    );
    provider.trigger("delayed", notification(2, "2026-11-22T09:00:00.000Z"));

    expect(provider.listPage(7, { pageSize: 1 })).toMatchObject({
      items: [
        {
          id: "delayed",
          occurredAt: "2026-11-22T09:00:00.000Z",
        },
      ],
      nextCursor: "1",
    });
    expect(provider.listPage(7, { cursor: "1", pageSize: 1 })).toMatchObject({
      items: [{ id: "already-present" }],
      nextCursor: null,
    });
  });

  test("Mark all read includes unloaded Notifications but not a racing later arrival", () => {
    const provider = new FakeKnockAdapter();
    const notification = (id: number, occurredAt: string) => ({
      eventIdentity: `question.created:${id}`,
      eventKind: "question.created" as const,
      actorCapacity: "student" as const,
      occurredAt,
      sourceCommentId: id,
      rootQuestionId: id,
      recipientId: 7,
      courseId: 3,
      lessonId: 9,
    });
    provider.trigger("first", notification(1, "2026-11-23T10:00:00.000Z"));
    provider.trigger("unloaded", notification(2, "2026-11-23T11:00:00.000Z"));

    expect(provider.markAllRead(7, "2026-11-23T12:00:00.000Z")).toBe(true);
    provider.trigger("later", notification(3, "2026-11-23T12:00:01.000Z"));

    expect(provider.list(7).map(({ id, readAt }) => ({ id, readAt }))).toEqual([
      { id: "later", readAt: null },
      { id: "unloaded", readAt: "2026-11-23T12:00:00.000Z" },
      { id: "first", readAt: "2026-11-23T12:00:00.000Z" },
    ]);
  });

  test("failed read mutations leave authoritative state unchanged", () => {
    const provider = new FakeKnockAdapter();
    provider.trigger("one", {
      eventIdentity: "question.created:1",
      eventKind: "question.created",
      actorCapacity: "student",
      occurredAt: "2026-11-23T12:00:00.000Z",
      sourceCommentId: 1,
      rootQuestionId: 1,
      recipientId: 7,
      courseId: 3,
      lessonId: 9,
    });
    provider.failNextRead();

    expect(provider.markRead(7, "one")).toBe(false);
    expect(provider.list(7)[0]?.readAt).toBeNull();

    provider.failNextMarkAllRead();
    expect(provider.markAllRead(7)).toBe(false);
    expect(provider.list(7)[0]?.readAt).toBeNull();
  });

  test("read changes preserve provider order and recipient independence", () => {
    const provider = new FakeKnockAdapter();
    for (const recipientId of [7, 8]) {
      provider.trigger(`same-event:${recipientId}`, {
        eventIdentity: "question.created:42",
        eventKind: "question.created",
        actorCapacity: "student",
        occurredAt: "2026-11-23T12:00:00.000Z",
        sourceCommentId: 42,
        rootQuestionId: 42,
        recipientId,
        courseId: 3,
        lessonId: 9,
      });
    }
    provider.trigger("newer", {
      eventIdentity: "question.created:43",
      eventKind: "question.created",
      actorCapacity: "student",
      occurredAt: "2026-11-23T13:00:00.000Z",
      sourceCommentId: 43,
      rootQuestionId: 43,
      recipientId: 7,
      courseId: 3,
      lessonId: 9,
    });

    provider.markRead(7, "same-event:7", "2026-11-23T14:00:00.000Z");

    expect(provider.list(7).map((item) => item.id)).toEqual([
      "newer",
      "same-event:7",
    ]);
    expect(provider.list(8)[0]?.readAt).toBeNull();
  });
});
