import { describe, expect, test, vi } from "vitest";
import {
  FakeKnockAdapter,
  KnockNotificationProvider,
  UnsupportedProviderOperationError,
  type NotificationPayload,
} from "~/services/notificationProvider";

describe("FakeKnockAdapter", () => {
  test("only the recipient can list or mark a Notification read", () => {
    const provider = new FakeKnockAdapter();
    provider.trigger("event:recipient:in_app", {
      eventIdentity: "question.created:42",
      eventKind: "question.created",
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

describe("KnockNotificationProvider", () => {
  test("uses Knock as the authoritative person-scoped Feed and read store", async () => {
    const payload = {
      eventIdentity: "question.created:42",
      eventKind: "question.created" as const,
      occurredAt: "2026-11-24T10:00:00.000Z",
      sourceCommentId: 42,
      rootQuestionId: 42,
      recipientId: 7,
      courseId: 3,
      lessonId: 9,
    };
    const feedResponse = (
      entries: unknown[],
      after: string | null,
      unreadCount: number
    ) =>
      new Response(
        JSON.stringify({
          entries,
          meta: { unread_count: unreadCount },
          page_info: { after },
        })
      );
    const entry = {
      id: "msg_42",
      read_at: null,
      data: payload,
      source: { key: "student-question-created" },
    };
    const request = vi
      .fn()
      .mockResolvedValueOnce(feedResponse([entry], "cursor_2", 2))
      .mockResolvedValueOnce(feedResponse([entry], null, 2))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "msg_42" }), { status: 200 })
      )
      .mockResolvedValueOnce(feedResponse([entry], null, 1))
      .mockResolvedValueOnce(
        new Response(JSON.stringify([{ id: "msg_42" }]), {
          status: 200,
        })
      );
    const provider = new KnockNotificationProvider({
      secretApiKey: "sk_test_secret",
      feedChannelId: "feed/channel",
      request,
    });

    await expect(
      provider.listPage(7, { cursor: "cursor_1", pageSize: 1 })
    ).resolves.toEqual({
      items: [
        {
          ...payload,
          id: "msg_42",
          idempotencyKey: "question.created:42:7:in_app",
          readAt: null,
        },
      ],
      unreadCount: 2,
      nextCursor: "cursor_2",
    });
    await expect(provider.markRead(7, "msg_42")).resolves.toBe(true);
    await expect(provider.markAllRead(7)).resolves.toBe(true);

    expect(request.mock.calls.map(([url]) => url)).toEqual([
      "https://api.knock.app/v1/users/7/feeds/feed%2Fchannel?status=all&archived=exclude&mode=compact&page_size=1&after=cursor_1",
      "https://api.knock.app/v1/users/7/feeds/feed%2Fchannel?status=all&archived=exclude&mode=compact&page_size=50",
      "https://api.knock.app/v1/messages/msg_42/read",
      "https://api.knock.app/v1/users/7/feeds/feed%2Fchannel?status=unread&archived=exclude&mode=compact&page_size=50",
      "https://api.knock.app/v1/messages/batch/read",
    ]);
    expect(request).toHaveBeenLastCalledWith(
      "https://api.knock.app/v1/messages/batch/read",
      expect.objectContaining({
        body: JSON.stringify({ message_ids: ["msg_42"] }),
      })
    );
  });

  test("rejects Feed data outside the allowlist or authenticated person scope", async () => {
    const provider = new KnockNotificationProvider({
      secretApiKey: "sk_test_secret",
      feedChannelId: "feed_test",
      request: async () =>
        new Response(
          JSON.stringify({
            entries: [
              {
                id: "msg_42",
                read_at: null,
                data: {
                  eventIdentity: "question.created:42",
                  eventKind: "question.created",
                  occurredAt: "2026-11-24T10:00:00.000Z",
                  sourceCommentId: 42,
                  rootQuestionId: 42,
                  recipientId: 8,
                  courseId: 3,
                  lessonId: 9,
                  preview: "must not enter Knock",
                },
                source: { key: "student-question-created" },
              },
            ],
            meta: { unread_count: 1 },
            page_info: { after: null },
          })
        ),
    });

    await expect(provider.listPage(7)).rejects.toThrow();
  });

  test("refuses to represent archive as per-message permanent deletion", () => {
    const provider = new KnockNotificationProvider({
      secretApiKey: "sk_test_secret",
      feedChannelId: "feed_test",
      request: vi.fn(),
    });

    expect(() =>
      provider.permanentlyDeleteNotification({
        messageId: "msg_123",
        idempotencyKey: "question.created:42:7:in_app",
        recipientId: 7,
      })
    ).toThrow(
      new UnsupportedProviderOperationError("per-message permanent deletion")
    );
  });

  test("uses archive only as reversible containment and hard-deletes a whole User", async () => {
    const request = vi.fn(async () => new Response(null, { status: 204 }));
    const provider = new KnockNotificationProvider({
      secretApiKey: "sk_test_secret",
      feedChannelId: "feed_test",
      request,
    });

    await provider.archiveNotification("msg/123");
    await provider.deleteUser(7);

    expect(request).toHaveBeenNthCalledWith(
      1,
      "https://api.knock.app/v1/messages/msg%2F123/archived",
      {
        method: "PUT",
        headers: { Authorization: "Bearer sk_test_secret" },
      }
    );
    expect(request).toHaveBeenNthCalledWith(
      2,
      "https://api.knock.app/v1/users/7",
      {
        method: "DELETE",
        headers: { Authorization: "Bearer sk_test_secret" },
      }
    );
  });

  test("triggers one stable person with the exact approved payload and identity", async () => {
    const request = vi.fn(
      async () =>
        new Response(JSON.stringify({ workflow_run_id: "run_123" }), {
          status: 200,
          headers: { "x-request-id": "req_123" },
        })
    );
    const provider = new KnockNotificationProvider({
      secretApiKey: "sk_test_secret",
      feedChannelId: "feed_test",
      request,
    });
    const payload = {
      eventIdentity: "staff-reply.created:42",
      eventKind: "staff-reply.created" as const,
      occurredAt: "2026-11-24T10:00:00.000Z",
      sourceCommentId: 42,
      rootQuestionId: 40,
      recipientId: 7,
      courseId: 3,
      lessonId: 9,
    };

    await expect(
      provider.trigger("staff-reply.created:42:7:in_app", payload)
    ).resolves.toEqual({ workflowRunId: "run_123", requestId: "req_123" });
    expect(request).toHaveBeenCalledWith(
      "https://api.knock.app/v1/workflows/staff-reply-created/trigger",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer sk_test_secret",
          "Content-Type": "application/json",
          "Idempotency-Key": "staff-reply.created:42:7:in_app",
        },
        body: JSON.stringify({ recipients: ["7"], data: payload }),
      }
    );
  });

  test("rejects a failed trigger with content-free provider evidence", async () => {
    const provider = new KnockNotificationProvider({
      secretApiKey: "sk_test_secret",
      feedChannelId: "feed_test",
      request: async () =>
        new Response(JSON.stringify({ error: "may contain sensitive data" }), {
          status: 422,
          headers: { "x-request-id": "req_failed" },
        }),
    });

    await expect(
      provider.trigger("question.created:42:7:in_app", {
        eventIdentity: "question.created:42",
        eventKind: "question.created",
        occurredAt: "2026-11-24T10:00:00.000Z",
        sourceCommentId: 42,
        rootQuestionId: 42,
        recipientId: 7,
        courseId: 3,
        lessonId: 9,
      })
    ).rejects.toThrow("Knock trigger failed (status 422, request req_failed)");
  });

  test("rejects extra actor or content fields before contacting Knock", async () => {
    const request = vi.fn<typeof fetch>();
    const provider = new KnockNotificationProvider({
      secretApiKey: "sk_test_secret",
      feedChannelId: "feed_test",
      request,
    });
    const unsafePayload = {
      eventIdentity: "question.created:42",
      eventKind: "question.created",
      occurredAt: "2026-11-24T10:00:00.000Z",
      sourceCommentId: 42,
      rootQuestionId: 42,
      recipientId: 7,
      courseId: 3,
      lessonId: 9,
      actorId: 6,
      preview: "private discussion text",
    } as unknown as NotificationPayload;

    await expect(
      provider.trigger("question.created:42:7:in_app", unsafePayload)
    ).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });

  test("resolves a workflow-run reference to its confirmed in-app message", async () => {
    const request = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            items: [
              {
                id: "msg_123",
                status: "delivered",
                updated_at: "2026-11-24T10:00:01.000Z",
              },
            ],
          })
        )
    );
    const provider = new KnockNotificationProvider({
      secretApiKey: "sk_test_secret",
      feedChannelId: "feed_test",
      request,
    });

    await expect(
      provider.lookupOutcome("run_123", "question.created:42:7:in_app")
    ).resolves.toEqual({
      kind: "delivered",
      messageIds: ["msg_123"],
      occurredAt: "2026-11-24T10:00:01.000Z",
    });
    expect(request).toHaveBeenCalledWith(
      "https://api.knock.app/v1/messages?workflow_run_id=run_123&page_size=50",
      { headers: { Authorization: "Bearer sk_test_secret" } }
    );
  });

  test("reports zero, failed, and duplicate workflow-run messages safely", async () => {
    const responses = [
      { items: [] },
      {
        items: [
          {
            workflow_run_id: "run_pending",
            status: "processing",
            error_count: 0,
            updated_at: "2026-11-24T10:00:00.000Z",
          },
        ],
      },
      {
        items: [
          {
            id: "msg_failed",
            status: "not_sent",
            updated_at: "2026-11-24T10:00:01.000Z",
          },
        ],
      },
      {
        items: [
          {
            id: "msg_one",
            status: "delivered",
            updated_at: "2026-11-24T10:00:01.000Z",
          },
          {
            id: "msg_two",
            status: "delivered",
            updated_at: "2026-11-24T10:00:02.000Z",
          },
        ],
      },
      { items: [] },
      {
        items: [
          {
            workflow_run_id: "run_skipped",
            status: "completed",
            error_count: 0,
            updated_at: "2026-11-24T10:00:03.000Z",
          },
        ],
      },
    ];
    const provider = new KnockNotificationProvider({
      secretApiKey: "sk_test_secret",
      feedChannelId: "feed_test",
      request: vi.fn(
        async () => new Response(JSON.stringify(responses.shift()))
      ),
    });

    await expect(
      provider.lookupOutcome("run_pending", "question.created:1:7:in_app")
    ).resolves.toEqual({ kind: "pending" });
    await expect(
      provider.lookupOutcome("run_failed", "question.created:1:7:in_app")
    ).resolves.toMatchObject({
      kind: "permanently_failed",
      messageIds: ["msg_failed"],
    });
    await expect(
      provider.lookupOutcome("run_duplicate", "question.created:1:7:in_app")
    ).resolves.toMatchObject({
      kind: "unknown",
      messageIds: ["msg_one", "msg_two"],
    });
    await expect(
      provider.lookupOutcome("run_skipped", "question.created:1:7:in_app")
    ).resolves.toEqual({
      kind: "skipped",
      occurredAt: "2026-11-24T10:00:03.000Z",
    });
  });
});
