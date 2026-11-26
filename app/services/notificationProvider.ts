import { z } from "zod";
import type { ProviderDeliveryOutcome } from "~/services/notificationOutcomeService.server";

export const notificationPayloadSchema = z
  .object({
    eventIdentity: z.string().min(1).max(255),
    eventKind: z.enum(["question.created", "staff-reply.created"]),
    occurredAt: z.string().datetime({ offset: true }),
    sourceCommentId: z.number().int().positive(),
    rootQuestionId: z.number().int().positive(),
    recipientId: z.number().int().positive(),
    courseId: z.number().int().positive(),
    lessonId: z.number().int().positive(),
  })
  .strict()
  .superRefine((payload, context) => {
    if (
      payload.eventIdentity !==
      `${payload.eventKind}:${payload.sourceCommentId}`
    ) {
      context.addIssue({
        code: "custom",
        path: ["eventIdentity"],
        message: "must be derived from the event kind and source comment",
      });
    }
  });

export type NotificationPayload = z.infer<typeof notificationPayloadSchema>;

export type ProviderNotification = NotificationPayload & {
  id: string;
  idempotencyKey: string;
  readAt: string | null;
};

export interface NotificationProvider {
  trigger(
    idempotencyKey: string,
    payload: NotificationPayload,
    options?: { signal?: AbortSignal }
  ): void | ProviderTriggerResult | Promise<void | ProviderTriggerResult>;
  lookupOutcome?(
    workflowRunId: string,
    idempotencyKey: string
  ): Promise<ProviderDeliveryOutcome>;
}

export class NotificationProviderError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterMs?: number
  ) {
    super(message);
    this.name = "NotificationProviderError";
  }
}

export type ProviderTriggerResult = {
  workflowRunId: string;
  requestId: string | null;
};

const WORKFLOW_KEYS = {
  "question.created": "student-question-created",
  "staff-reply.created": "staff-reply-created",
} as const;

type KnockNotificationProviderOptions = {
  secretApiKey: string;
  request?: typeof fetch;
  apiBaseUrl?: string;
};

export class KnockNotificationProvider implements NotificationProvider {
  private readonly secretApiKey: string;
  private readonly request: typeof fetch;
  private readonly apiBaseUrl: string;

  constructor({
    secretApiKey,
    request = fetch,
    apiBaseUrl = "https://api.knock.app/v1",
  }: KnockNotificationProviderOptions) {
    this.secretApiKey = secretApiKey;
    this.request = request;
    this.apiBaseUrl = apiBaseUrl.replace(/\/$/, "");
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
    const workflowKey = WORKFLOW_KEYS[payload.eventKind];
    const response = await this.request(
      `${this.apiBaseUrl}/workflows/${workflowKey}/trigger`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.secretApiKey}`,
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify({
          recipients: [String(payload.recipientId)],
          data: payload,
        }),
        signal: options?.signal,
      }
    );
    const requestId = response.headers.get("x-request-id");
    if (!response.ok) {
      const retryAfter = response.headers.get("retry-after");
      const retryAfterMs = retryAfter
        ? parseRetryAfter(retryAfter, Date.now())
        : undefined;
      throw new NotificationProviderError(
        `Knock trigger failed (status ${response.status}, request ${requestId ?? "unknown"})`,
        response.status,
        retryAfterMs
      );
    }
    const result = z
      .object({ workflow_run_id: z.string().min(1) })
      .passthrough()
      .parse(await response.json());
    return { workflowRunId: result.workflow_run_id, requestId };
  }

  async lookupOutcome(workflowRunId: string, idempotencyKey: string) {
    const query = new URLSearchParams({
      workflow_run_id: workflowRunId,
      page_size: "50",
    });
    const response = await this.request(
      `${this.apiBaseUrl}/messages?${query}`,
      {
        headers: { Authorization: `Bearer ${this.secretApiKey}` },
      }
    );
    if (!response.ok) {
      throw new NotificationProviderError(
        `Knock outcome lookup failed (status ${response.status})`,
        response.status
      );
    }
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
        { headers: { Authorization: `Bearer ${this.secretApiKey}` } }
      );
      if (!runResponse.ok) {
        throw new NotificationProviderError(
          `Knock workflow-run lookup failed (status ${runResponse.status})`,
          runResponse.status
        );
      }
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
      if (!run || ["queued", "processing", "paused"].includes(run.status)) {
        return { kind: "pending" as const };
      }
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
    const message = messages[0]!;
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
}

export function parseRetryAfter(value: string, nowMs: number) {
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const date = Date.parse(value);
  if (!Number.isFinite(date)) return undefined;
  return Math.max(0, date - nowMs);
}

export type NotificationPage = {
  items: ProviderNotification[];
  unreadCount: number;
  nextCursor: string | null;
};

/** Local/test Knock substitute. It deliberately stores only the payload allowlist. */
export class FakeKnockAdapter implements NotificationProvider {
  private notifications = new Map<string, ProviderNotification>();
  private workflowRuns = new Map<string, string>();
  private pending: Promise<void>[] = [];
  private rejectNextRead = false;
  private rejectNextMarkAll = false;

  trigger(idempotencyKey: string, payload: NotificationPayload) {
    const workflowRunId = `fake-run:${idempotencyKey}`;
    if (this.notifications.has(idempotencyKey)) {
      return { workflowRunId, requestId: `fake-request:${idempotencyKey}` };
    }
    this.notifications.set(idempotencyKey, {
      ...payload,
      id: idempotencyKey,
      idempotencyKey,
      readAt: null,
    });
    this.workflowRuns.set(workflowRunId, idempotencyKey);
    return { workflowRunId, requestId: `fake-request:${idempotencyKey}` };
  }

  async lookupOutcome(workflowRunId: string, idempotencyKey: string) {
    const key = this.workflowRuns.get(workflowRunId);
    const notification = key ? this.notifications.get(key) : undefined;
    if (!notification || key !== idempotencyKey)
      return { kind: "pending" as const };
    return {
      kind: "delivered" as const,
      messageIds: [notification.id],
      occurredAt: notification.occurredAt,
    };
  }

  schedule(idempotencyKey: string, payload: NotificationPayload) {
    const work = Promise.resolve()
      .then(() => {
        this.trigger(idempotencyKey, payload);
      })
      .catch(() => undefined);
    this.pending.push(work);
  }

  async settled() {
    await Promise.all(this.pending);
    this.pending = [];
  }

  list(recipientId: number) {
    return [...this.notifications.values()]
      .filter((item) => item.recipientId === recipientId)
      .reverse();
  }

  listPage(
    recipientId: number,
    { cursor, pageSize = 20 }: { cursor?: string; pageSize?: number } = {}
  ): NotificationPage {
    const items = this.list(recipientId);
    const offset = cursor ? Number.parseInt(cursor, 10) : 0;
    const safeOffset = Number.isFinite(offset) && offset >= 0 ? offset : 0;
    const page = items.slice(safeOffset, safeOffset + pageSize);
    const nextOffset = safeOffset + page.length;
    return {
      items: page,
      unreadCount: items.filter((item) => item.readAt === null).length,
      nextCursor: nextOffset < items.length ? String(nextOffset) : null,
    };
  }

  markRead(recipientId: number, id: string, readAt = new Date().toISOString()) {
    if (this.rejectNextRead) {
      this.rejectNextRead = false;
      return false;
    }
    const item = this.notifications.get(id);
    if (!item || item.recipientId !== recipientId) return false;
    item.readAt ??= readAt;
    return true;
  }

  markAllRead(recipientId: number, readAt = new Date().toISOString()) {
    if (this.rejectNextMarkAll) {
      this.rejectNextMarkAll = false;
      return false;
    }
    for (const item of this.notifications.values()) {
      if (item.recipientId === recipientId) item.readAt ??= readAt;
    }
    return true;
  }

  failNextRead() {
    this.rejectNextRead = true;
  }

  failNextMarkAllRead() {
    this.rejectNextMarkAll = true;
  }

  reset() {
    this.notifications.clear();
    this.workflowRuns.clear();
    this.pending = [];
    this.rejectNextRead = false;
    this.rejectNextMarkAll = false;
  }
}

export const fakeKnockAdapter = new FakeKnockAdapter();
