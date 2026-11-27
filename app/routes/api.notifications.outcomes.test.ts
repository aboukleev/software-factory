import { createHmac } from "node:crypto";
import { describe, expect, test, vi } from "vitest";
import { createNotificationOutcomeAction } from "~/services/notificationOutcomeWebhook.server";

describe("POST /api/notifications/outcomes", () => {
  test("authenticates and maps a Knock delivered event", async () => {
    const body = JSON.stringify({
      id: "evt_123",
      type: "message.delivered",
      created_at: "2026-01-01T00:00:02.000Z",
      data: {
        id: "msg_123",
        updated_at: "2026-01-01T00:00:02.000Z",
        source: { workflow_run_id: "run_123" },
      },
    });
    const timestamp = "1767225600000";
    const signature = createHmac("sha256", "secret")
      .update(`${timestamp}.${body}`)
      .digest("base64");
    const recordOutcome = vi.fn(() => ({ applied: true as const }));
    const action = createNotificationOutcomeAction({
      secret: "secret",
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      recordOutcome,
    });

    const response = await action({
      request: new Request("http://cadence.test/api/notifications/outcomes", {
        method: "POST",
        headers: { "x-knock-signature": `t=${timestamp},s=${signature}` },
        body,
      }),
    });

    expect(response.status).toBe(204);
    expect(recordOutcome).toHaveBeenCalledWith({
      providerEventId: "evt_123",
      workflowRunId: "run_123",
      kind: "delivered",
      providerMessageIds: ["msg_123"],
      occurredAt: "2026-01-01T00:00:02.000Z",
    });
  });

  test.each(["message.undelivered", "message.not_sent", "message.bounced"])(
    "maps %s to a permanent Delivery failure",
    async (type) => {
      const body = JSON.stringify({
        id: `evt_${type}`,
        type,
        created_at: "2026-01-01T00:00:02.000Z",
        data: {
          id: "msg_failed",
          source: { workflow_run_id: "run_123" },
        },
      });
      const timestamp = "1767225600000";
      const signature = createHmac("sha256", "secret")
        .update(`${timestamp}.${body}`)
        .digest("base64");
      const recordOutcome = vi.fn(() => ({ applied: true as const }));

      const response = await createNotificationOutcomeAction({
        secret: "secret",
        now: () => new Date("2026-01-01T00:00:00.000Z"),
        recordOutcome,
      })({
        request: new Request("http://cadence.test/api/notifications/outcomes", {
          method: "POST",
          headers: { "x-knock-signature": `t=${timestamp},s=${signature}` },
          body,
        }),
      });

      expect(response.status).toBe(204);
      expect(recordOutcome).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "permanently_failed" })
      );
    }
  );

  test("rejects an invalid signature without recording an outcome", async () => {
    const recordOutcome = vi.fn();
    await expect(
      createNotificationOutcomeAction({
        secret: "secret",
        recordOutcome,
      })({
        request: new Request("http://cadence.test/api/notifications/outcomes", {
          method: "POST",
          headers: { "x-knock-signature": "t=1,s=invalid" },
          body: "{}",
        }),
      })
    ).rejects.toMatchObject({ status: 401 });
    expect(recordOutcome).not.toHaveBeenCalled();
  });
});
