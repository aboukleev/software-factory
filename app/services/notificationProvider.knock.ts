import { z } from "zod";
import {
  notificationPayloadSchema,
  NotificationProviderError,
  UnsupportedProviderOperationError,
  type NotificationPage,
  type NotificationPayload,
  type NotificationProvider,
} from "./notificationProvider.contract";

const WORKFLOW_KEYS = {
  "question.created": "student-question-created",
  "staff-reply.created": "staff-reply-created",
} as const;

const feedItemSchema = z.object({
  id: z.string().min(1),
  read_at: z.string().datetime({ offset: true }).nullable().optional(),
  data: notificationPayloadSchema,
  source: z.object({
    key: z.enum(["student-question-created", "staff-reply-created"]),
  }),
});

const feedResponseSchema = z.object({
  entries: z.array(feedItemSchema),
  meta: z.object({ unread_count: z.number().int().nonnegative() }),
  page_info: z.object({ after: z.string().nullable().optional() }),
});
const messageMutationSchema = z.object({ id: z.string().min(1) });
const batchMutationSchema = z.array(
  z.object({ id: z.string().min(1) }).passthrough()
);

type KnockNotificationProviderOptions = {
  secretApiKey: string;
  feedChannelId: string;
  request?: typeof fetch;
  apiBaseUrl?: string;
};

export class KnockNotificationProvider implements NotificationProvider {
  private readonly secretApiKey: string;
  private readonly feedChannelId: string;
  private readonly request: typeof fetch;
  private readonly apiBaseUrl: string;

  constructor({
    secretApiKey,
    feedChannelId,
    request = fetch,
    apiBaseUrl = "https://api.knock.app/v1",
  }: KnockNotificationProviderOptions) {
    this.secretApiKey = secretApiKey;
    this.feedChannelId = feedChannelId;
    this.request = request;
    this.apiBaseUrl = apiBaseUrl.replace(/\/$/, "");
  }

  private headers(contentType = false) {
    return {
      Authorization: `Bearer ${this.secretApiKey}`,
      ...(contentType ? { "Content-Type": "application/json" } : {}),
    };
  }

  private providerError(operation: string, response: Response) {
    const retryAfter = response.headers.get("retry-after");
    return new NotificationProviderError(
      `Knock ${operation} failed (status ${response.status})`,
      response.status,
      retryAfter ? parseRetryAfter(retryAfter, Date.now()) : undefined
    );
  }

  async trigger(
    idempotencyKey: string,
    untrustedPayload: NotificationPayload,
    options?: { signal?: AbortSignal }
  ) {
    if (idempotencyKey.length === 0 || idempotencyKey.length > 255) {
      throw new Error(
        "Knock idempotency keys must contain 1 to 255 characters"
      );
    }
    const payload = notificationPayloadSchema.parse(untrustedPayload);
    const response = await this.request(
      `${this.apiBaseUrl}/workflows/${WORKFLOW_KEYS[payload.eventKind]}/trigger`,
      {
        method: "POST",
        headers: {
          ...this.headers(true),
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify({
          recipients: [String(payload.recipientId)],
          data: payload,
        }),
        ...(options?.signal ? { signal: options.signal } : {}),
      }
    );
    const requestId = response.headers.get("x-request-id");
    if (!response.ok) {
      const error = this.providerError("trigger", response);
      throw new NotificationProviderError(
        `Knock trigger failed (status ${response.status}, request ${requestId ?? "unknown"})`,
        error.status,
        error.retryAfterMs
      );
    }
    const result = z
      .object({ workflow_run_id: z.string().min(1) })
      .parse(await response.json());
    return { workflowRunId: result.workflow_run_id, requestId };
  }

  async listPage(
    recipientId: number,
    { cursor, pageSize = 20 }: { cursor?: string; pageSize?: number } = {}
  ): Promise<NotificationPage> {
    const query = new URLSearchParams({
      status: "all",
      archived: "exclude",
      mode: "compact",
      page_size: String(pageSize),
    });
    if (cursor) query.set("after", cursor);
    const response = await this.request(this.feedUrl(recipientId, query), {
      headers: this.headers(),
    });
    if (!response.ok) throw this.providerError("Feed lookup", response);
    const parsed = feedResponseSchema.parse(await response.json());
    return {
      items: parsed.entries.map((entry) =>
        this.toProviderNotification(recipientId, entry)
      ),
      unreadCount: parsed.meta.unread_count,
      nextCursor: parsed.page_info.after ?? null,
    };
  }

  async markRead(recipientId: number, notificationId: string) {
    const owned = await this.findOwnedNotification(recipientId, notificationId);
    if (!owned) return false;
    const response = await this.request(
      `${this.apiBaseUrl}/messages/${encodeURIComponent(notificationId)}/read`,
      { method: "PUT", headers: this.headers() }
    );
    if (!response.ok) throw this.providerError("read mutation", response);
    const changed = messageMutationSchema.parse(await response.json());
    if (changed.id !== notificationId)
      throw new Error("Knock changed an unexpected message");
    return true;
  }

  async markAllRead(recipientId: number) {
    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const query = new URLSearchParams({
        status: "unread",
        archived: "exclude",
        mode: "compact",
        page_size: "50",
      });
      if (cursor) query.set("after", cursor);
      const response = await this.request(this.feedUrl(recipientId, query), {
        headers: this.headers(),
      });
      if (!response.ok)
        throw this.providerError("unread Feed lookup", response);
      const parsed = feedResponseSchema.parse(await response.json());
      for (const entry of parsed.entries) {
        ids.push(this.toProviderNotification(recipientId, entry).id);
      }
      cursor = parsed.page_info.after ?? undefined;
    } while (cursor);

    for (let offset = 0; offset < ids.length; offset += 50) {
      const response = await this.request(
        `${this.apiBaseUrl}/messages/batch/read`,
        {
          method: "POST",
          headers: this.headers(true),
          body: JSON.stringify({ message_ids: ids.slice(offset, offset + 50) }),
        }
      );
      if (!response.ok)
        throw this.providerError("batch read mutation", response);
      const changed = batchMutationSchema.parse(await response.json());
      const requested = ids.slice(offset, offset + 50);
      if (
        changed.length !== requested.length ||
        changed.some((item) => !requested.includes(item.id))
      ) {
        throw new Error("Knock batch read changed unexpected messages");
      }
    }
    return true;
  }

  private feedUrl(recipientId: number, query: URLSearchParams) {
    return `${this.apiBaseUrl}/users/${encodeURIComponent(String(recipientId))}/feeds/${encodeURIComponent(this.feedChannelId)}?${query}`;
  }

  private toProviderNotification(
    recipientId: number,
    entry: z.infer<typeof feedItemSchema>
  ) {
    const payload = entry.data;
    if (
      payload.recipientId !== recipientId ||
      WORKFLOW_KEYS[payload.eventKind] !== entry.source.key
    ) {
      throw new Error(
        "Knock Feed item violated the Cadence recipient or workflow contract"
      );
    }
    return {
      ...payload,
      id: entry.id,
      idempotencyKey: `${payload.eventIdentity}:${recipientId}:in_app`,
      readAt: entry.read_at ?? null,
    };
  }

  private async findOwnedNotification(
    recipientId: number,
    notificationId: string
  ) {
    let cursor: string | undefined;
    do {
      const page = await this.listPage(recipientId, { cursor, pageSize: 50 });
      if (page.items.some((item) => item.id === notificationId)) return true;
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    return false;
  }

  async lookupOutcome(workflowRunId: string, idempotencyKey: string) {
    const query = new URLSearchParams({
      workflow_run_id: workflowRunId,
      page_size: "50",
    });
    const response = await this.request(
      `${this.apiBaseUrl}/messages?${query}`,
      {
        headers: this.headers(),
      }
    );
    if (!response.ok) throw this.providerError("outcome lookup", response);
    const result = z
      .object({
        items: z.array(
          z.object({
            id: z.string().min(1),
            status: z.enum([
              "queued",
              "sent",
              "delivered",
              "delivery_attempted",
              "undelivered",
              "not_sent",
              "bounced",
            ]),
            updated_at: z.string().datetime({ offset: true }),
          })
        ),
      })
      .parse(await response.json());
    const messages = result.items;
    if (messages.length === 0) {
      const recipientId = idempotencyKey.split(":").at(-2);
      if (!recipientId) return { kind: "pending" as const };
      const runQuery = new URLSearchParams({
        recipient: recipientId,
        page_size: "50",
      });
      const runResponse = await this.request(
        `${this.apiBaseUrl}/workflow_recipient_runs?${runQuery}`,
        {
          headers: this.headers(),
        }
      );
      if (!runResponse.ok)
        throw this.providerError("workflow-run lookup", runResponse);
      const runs = z
        .object({
          items: z.array(
            z.object({
              workflow_run_id: z.string().min(1),
              status: z.enum([
                "queued",
                "processing",
                "paused",
                "completed",
                "cancelled",
              ]),
              error_count: z.number().int().nonnegative(),
              updated_at: z.string().datetime({ offset: true }),
            })
          ),
        })
        .parse(await runResponse.json());
      const run = runs.items.find(
        (candidate) => candidate.workflow_run_id === workflowRunId
      );
      if (!run || ["queued", "processing", "paused"].includes(run.status))
        return { kind: "pending" as const };
      if (run.status === "completed" && run.error_count === 0) {
        return { kind: "skipped" as const, occurredAt: run.updated_at };
      }
      return {
        kind: "permanently_failed" as const,
        occurredAt: run.updated_at,
      };
    }
    if (messages.length > 1) {
      return {
        kind: "unknown" as const,
        messageIds: messages.map((message) => message.id),
        occurredAt: messages[0]?.updated_at,
      };
    }
    const message = messages[0];
    if (!message) return { kind: "pending" as const };
    if (message.status === "delivered") {
      return {
        kind: "delivered" as const,
        messageIds: [message.id],
        occurredAt: message.updated_at,
      };
    }
    if (["undelivered", "not_sent", "bounced"].includes(message.status)) {
      return {
        kind: "permanently_failed" as const,
        messageIds: [message.id],
        occurredAt: message.updated_at,
      };
    }
    return { kind: "pending" as const, messageIds: [message.id] };
  }

  permanentlyDeleteNotification(_input: {
    messageId: string | null;
    idempotencyKey: string;
    recipientId: number;
  }) {
    throw new UnsupportedProviderOperationError(
      "per-message permanent deletion"
    );
  }

  async archiveNotification(messageId: string) {
    const response = await this.request(
      `${this.apiBaseUrl}/messages/${encodeURIComponent(messageId)}/archived`,
      {
        method: "PUT",
        headers: this.headers(),
      }
    );
    if (!response.ok) throw this.providerError("archive", response);
  }

  async deleteUser(userId: number) {
    const response = await this.request(
      `${this.apiBaseUrl}/users/${encodeURIComponent(String(userId))}`,
      {
        method: "DELETE",
        headers: this.headers(),
      }
    );
    if (!response.ok && response.status !== 404)
      throw this.providerError("User deletion", response);
  }
}

export function parseRetryAfter(value: string, nowMs: number) {
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const date = Date.parse(value);
  if (!Number.isFinite(date)) return undefined;
  return Math.max(0, date - nowMs);
}
