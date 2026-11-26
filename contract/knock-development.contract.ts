import { setTimeout as wait } from "node:timers/promises";
import Knock from "@knocklabs/client";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { z } from "zod";
import { loadNotificationConfig } from "../app/services/notificationConfig.server";
import {
  KnockNotificationProvider,
  type NotificationPayload,
} from "../app/services/notificationProvider";
import { createKnockUserToken } from "../app/services/notificationSecurity.server";

function loadContractConfig() {
  const loaded = loadNotificationConfig();
  if (loaded.mode !== "knock") {
    throw new Error(
      "Knock Development contract requires NOTIFICATION_PROVIDER_MODE=knock"
    );
  }
  return loaded;
}
const config = loadContractConfig();

const apiBaseUrl = "https://api.knock.app/v1";
const userToken = createKnockUserToken(
  Number.MAX_SAFE_INTEGER - Math.floor(Math.random() * 1_000_000),
  config.signingKey
);
// The token subject must equal the disposable Knock User ID. Contract IDs are
// therefore numeric strings, just like production Cadence person identifiers.
const tokenPayload = JSON.parse(
  Buffer.from(userToken.split(".")[1] ?? "", "base64url").toString("utf8")
) as { sub?: string };
const stableRecipientId = tokenPayload.sub;
if (!stableRecipientId) throw new Error("Contract token has no subject");

const publicHeaders = {
  Authorization: `Bearer ${config.publicApiKey}`,
  "X-Knock-User-Token": userToken,
  "Content-Type": "application/json",
};
const secretHeaders = {
  Authorization: `Bearer ${config.secretApiKey}`,
  "Content-Type": "application/json",
};

const feedSchema = z.object({
  entries: z.array(
    z
      .object({
        id: z.string().min(1),
        data: z.record(z.string(), z.unknown()),
        actors: z.array(z.unknown()).optional(),
        read_at: z.string().nullable().optional(),
        source: z.object({
          key: z.string(),
          version_id: z.string().min(1),
        }),
      })
      .passthrough()
  ),
  meta: z.object({
    unread_count: z.number(),
    total_count: z.number(),
  }),
  page_info: z.object({
    after: z.string().nullable().optional(),
  }),
});

const missingUserTokenErrorSchema = z.object({
  code: z.literal("missing_user_token"),
  status: z.literal(400),
  type: z.literal("authentication_error"),
});

// Real-time delivery is a lossy refresh signal. Validate only the stable
// metadata envelope that Cadence uses to decide to reconcile; item content is
// deliberately neither trusted nor applied by the browser client.
const realtimeHintSchema = z
  .object({
    event: z.literal("items.received.realtime"),
    items: z.array(z.unknown()),
    metadata: z
      .object({
        unread_count: z.number().int().nonnegative(),
        total_count: z.number().int().nonnegative(),
      })
      .passthrough(),
  })
  .passthrough();

async function readJson(response: Response) {
  const body = (await response.json()) as unknown;
  if (!response.ok) {
    throw new Error(`Knock API failed with status ${response.status}`);
  }
  return body;
}

async function getFeed(after?: string) {
  const query = new URLSearchParams({ mode: "compact", page_size: "1" });
  if (after) query.set("after", after);
  const response = await fetch(
    `${apiBaseUrl}/users/${stableRecipientId}/feeds/${config.feedChannelId}?${query}`,
    { headers: publicHeaders }
  );
  return feedSchema.parse(await readJson(response));
}

async function waitForFeedCount(count: number) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const feed = await getFeed();
    if (feed.meta.total_count >= count) return feed;
    await wait(500);
  }
  throw new Error(`Timed out waiting for ${count} Knock Feed items`);
}

async function waitForFeedMessage(messageId: string, present: boolean) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const response = await fetch(
      `${apiBaseUrl}/users/${stableRecipientId}/feeds/${config.feedChannelId}?mode=compact&page_size=50`,
      { headers: publicHeaders }
    );
    const current = feedSchema.parse(await readJson(response));
    if (current.entries.some((entry) => entry.id === messageId) === present) {
      return;
    }
    await wait(500);
  }
  throw new Error(
    `Timed out waiting for Knock Feed message to be ${present ? "present" : "absent"}`
  );
}

async function waitForRecipientMessagesToBeDeleted() {
  // Knock processes hard deletion asynchronously and documents that it can
  // take up to ten minutes before all associated data disappears.
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const query = new URLSearchParams({
      recipient: stableRecipientId!,
      page_size: "50",
    });
    const response = await fetch(`${apiBaseUrl}/messages?${query}`, {
      headers: secretHeaders,
    });
    const result = z
      .object({ items: z.array(z.object({ id: z.string() }).passthrough()) })
      .parse(await readJson(response));
    if (result.items.length === 0) return;
    await wait(1_000);
  }
  throw new Error("Timed out waiting for Knock User messages to be deleted");
}

async function waitForDeliveredOutcome(
  provider: KnockNotificationProvider,
  workflowRunId: string,
  idempotencyKey: string
) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const outcome = await provider.lookupOutcome(workflowRunId, idempotencyKey);
    if (outcome.kind === "delivered") return outcome;
    await wait(500);
  }
  throw new Error("Timed out waiting for Knock to confirm in-app Delivery");
}

function payload(
  eventKind: NotificationPayload["eventKind"],
  sourceCommentId: number
): NotificationPayload {
  return {
    eventIdentity: `${eventKind}:${sourceCommentId}`,
    eventKind,
    occurredAt: new Date().toISOString(),
    sourceCommentId,
    rootQuestionId:
      eventKind === "question.created" ? sourceCommentId : sourceCommentId - 1,
    recipientId: Number(stableRecipientId),
    courseId: 1,
    lessonId: 1,
  };
}

const knock = new Knock(config.publicApiKey);
knock.authenticate({ id: stableRecipientId }, userToken, {
  identificationStrategy: "skip",
});
const feed = knock.feeds.initialize(config.feedChannelId, {
  page_size: 1,
  mode: "compact",
});

async function waitForRealtimeConnection() {
  const socket = knock.client().socket;
  if (!socket) {
    throw new Error("Knock Feed contract has no real-time socket");
  }
  if (socket.isConnected()) return;

  await Promise.race([
    new Promise<void>((resolve) => {
      socket.onOpen(resolve);
      if (socket.isConnected()) resolve();
    }),
    wait(15_000).then(() => {
      throw new Error("Timed out connecting to Knock real-time service");
    }),
  ]);
}

async function waitForRealtimeChannel() {
  const socket = knock.client().socket as
    | (NonNullable<ReturnType<typeof knock.client>["socket"]> & {
        channels: Array<{ state: string; topic: string }>;
      })
    | undefined;
  if (!socket) {
    throw new Error("Knock Feed contract has no real-time socket");
  }

  for (let attempt = 0; attempt < 150; attempt += 1) {
    const channel = socket.channels.find(
      (candidate) => candidate.topic === feed.socketChannelTopic
    );
    if (channel?.state === "joined") return;
    await wait(100);
  }

  const state = socket.channels.find(
    (candidate) => candidate.topic === feed.socketChannelTopic
  )?.state;
  throw new Error(
    `Timed out joining Knock Feed real-time channel (state ${state ?? "missing"})`
  );
}

beforeAll(async () => {
  const identifyResponse = await fetch(
    `${apiBaseUrl}/users/${stableRecipientId}`,
    {
      method: "PUT",
      headers: secretHeaders,
      body: "{}",
    }
  );
  if (!identifyResponse.ok) {
    throw new Error(
      `Could not create disposable Knock recipient (status ${identifyResponse.status})`
    );
  }

  feed.listenForUpdates();
  await waitForRealtimeConnection();
  await waitForRealtimeChannel();
});

afterAll(async () => {
  feed.dispose();
  knock.logout();
  const response = await fetch(`${apiBaseUrl}/users/${stableRecipientId}`, {
    method: "DELETE",
    headers: secretHeaders,
  });
  if (!response.ok && response.status !== 404) {
    throw new Error(
      `Could not clean disposable Knock recipient (status ${response.status})`
    );
  }
});

describe("Knock Development security contract", () => {
  test("provides the browser runtime required for Feed real-time updates", () => {
    expect(knock.client().socket).toBeDefined();
  });

  test("requires enhanced-security tokens and exercises the complete Feed contract", async () => {
    const unsignedResponse = await fetch(
      `${apiBaseUrl}/users/${stableRecipientId}/feeds/${config.feedChannelId}`,
      { headers: { Authorization: `Bearer ${config.publicApiKey}` } }
    );
    expect(unsignedResponse.status).toBe(400);
    expect(
      missingUserTokenErrorSchema.parse(await unsignedResponse.json())
    ).toEqual({
      code: "missing_user_token",
      status: 400,
      type: "authentication_error",
    });

    const decodedToken = JSON.parse(
      Buffer.from(userToken.split(".")[1] ?? "", "base64url").toString("utf8")
    ) as Record<string, unknown>;
    expect(decodedToken).toMatchObject({
      sub: stableRecipientId,
      explicit_grants: true,
      grants: {
        [`https://api.knock.app/v1/users/${stableRecipientId}`]: {
          "user/feed_read": [{}],
          "user/feed_write": [{}],
        },
      },
    });

    let hintResolve: ((value: unknown) => void) | undefined;
    const hint = new Promise((resolve) => {
      hintResolve = resolve;
    });
    feed.on("items.received.realtime", (response: unknown) =>
      hintResolve?.(response)
    );

    const provider = new KnockNotificationProvider({
      secretApiKey: config.secretApiKey,
    });
    const firstIdentity = `question.created:${Date.now()}`;
    const firstPayload = payload(
      "question.created",
      Number(firstIdentity.split(":")[1])
    );
    const firstKey = `${firstIdentity}:${stableRecipientId}:in_app`;
    const firstResult = await provider.trigger(firstKey, firstPayload);
    const duplicateResult = await provider.trigger(firstKey, firstPayload);
    expect(duplicateResult.workflowRunId).toBe(firstResult.workflowRunId);
    expect(firstResult.requestId).toEqual(expect.any(String));

    await waitForFeedCount(1);
    const firstOutcome = await waitForDeliveredOutcome(
      provider,
      firstResult.workflowRunId,
      firstKey
    );
    expect(firstOutcome).toMatchObject({
      kind: "delivered",
      messageIds: [expect.any(String)],
      occurredAt: expect.any(String),
    });

    const realtimeHint = await Promise.race([
      hint,
      wait(15_000).then(() => {
        throw new Error("No Knock real-time Feed hint received");
      }),
    ]);
    const parsedHint = realtimeHintSchema.parse(realtimeHint);
    expect(parsedHint.metadata.total_count).toBeGreaterThanOrEqual(1);

    const secondSourceId = Number(firstIdentity.split(":")[1]) + 2;
    const secondResult = await provider.trigger(
      `staff-reply.created:${secondSourceId}:${stableRecipientId}:in_app`,
      payload("staff-reply.created", secondSourceId)
    );
    expect(secondResult.workflowRunId).toEqual(expect.any(String));

    const firstPage = await waitForFeedCount(2);
    expect(firstPage.entries).toHaveLength(1);
    const cursor = firstPage.page_info.after;
    expect(cursor).toEqual(expect.any(String));
    if (!cursor) throw new Error("Expected a cursor for the second Feed page");
    const secondPage = await getFeed(cursor);
    expect(secondPage.entries).toHaveLength(1);

    const items = [...firstPage.entries, ...secondPage.entries];
    const approvedData = [
      "courseId",
      "eventIdentity",
      "eventKind",
      "lessonId",
      "occurredAt",
      "recipientId",
      "rootQuestionId",
      "sourceCommentId",
    ];
    for (const item of items) {
      expect(Object.keys(item.data).sort()).toEqual(approvedData);
      expect(item.actors ?? []).toEqual([]);
      expect(item).not.toHaveProperty("actor");
      expect(item).not.toHaveProperty("recipient");
      expect(item).not.toHaveProperty("trigger_data");
      expect(item.source.version_id).toEqual(expect.any(String));
    }

    const message = firstPage.entries[0];
    if (!message) throw new Error("Expected a Feed message");
    await readJson(
      await fetch(`${apiBaseUrl}/messages/${message.id}/read`, {
        method: "PUT",
        headers: publicHeaders,
      })
    );
    const readFeed = await getFeed();
    expect(
      readFeed.entries.find((entry) => entry.id === message.id)?.read_at
    ).toEqual(expect.any(String));

    await provider.archiveNotification(message.id);
    await waitForFeedMessage(message.id, false);

    // Archive is reversible containment, not deletion: unarchiving restores
    // the same provider message.
    await readJson(
      await fetch(`${apiBaseUrl}/messages/${message.id}/archived`, {
        method: "DELETE",
        headers: secretHeaders,
      })
    );
    await waitForFeedMessage(message.id, true);

    // Knock has no per-message hard-delete operation. Deleting the disposable
    // User is the verified permanent mechanism and removes every recipient
    // message, so it must never be used to expire one Feed item.
    await provider.deleteUser(Number(stableRecipientId));
    await waitForRecipientMessagesToBeDeleted();
  });
});
