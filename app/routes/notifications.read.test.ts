import { beforeEach, describe, expect, test, vi } from "vitest";
import { fakeKnockAdapter } from "~/services/notificationProvider";
import { action } from "./notifications.read";

const session = vi.hoisted(() => ({ getCurrentUserId: vi.fn() }));
vi.mock("~/lib/session", () => ({
  getCurrentUserId: session.getCurrentUserId,
}));

function request(values: Record<string, string>) {
  return new Request("http://cadence.test/notifications/read", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(values),
  });
}

function add(id: string, recipientId = 7) {
  fakeKnockAdapter.trigger(id, {
    eventIdentity: `question.created:${id}`,
    occurredAt: "2026-11-23T12:00:00.000Z",
    sourceCommentId: 42,
    rootQuestionId: 42,
    recipientId,
    courseId: 3,
    lessonId: 9,
  });
}

beforeEach(() => {
  fakeKnockAdapter.reset();
  session.getCurrentUserId.mockResolvedValue(7);
});

describe("Notification read action", () => {
  test("marks only the activated recipient Notification", async () => {
    add("mine");
    add("theirs", 8);
    const response = await action({
      request: request({ intent: "mark-read", notificationId: "mine" }),
    } as never);
    expect(response.status).toBe(200);
    expect(fakeKnockAdapter.list(7)[0]?.readAt).not.toBeNull();
    expect(fakeKnockAdapter.list(8)[0]?.readAt).toBeNull();
  });

  test("returns a recoverable failure instead of throwing", async () => {
    add("mine");
    fakeKnockAdapter.failNextRead();
    const response = await action({
      request: request({ intent: "mark-read", notificationId: "mine" }),
    } as never);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false });
    expect(fakeKnockAdapter.list(7)[0]?.readAt).toBeNull();
  });

  test("marks every provider-side Notification read", async () => {
    add("visible");
    add("unloaded");
    const response = await action({
      request: request({ intent: "mark-all" }),
    } as never);
    expect(response.status).toBe(200);
    expect(fakeKnockAdapter.list(7).every((item) => item.readAt)).toBe(true);
  });
});
