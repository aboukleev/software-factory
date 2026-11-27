import { z } from "zod";

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
export type NotificationPage = {
  items: ProviderNotification[];
  unreadCount: number;
  nextCursor: string | null;
};

export type ProviderDeliveryOutcome = {
  kind:
    | "pending"
    | "delivered"
    | "skipped"
    | "permanently_failed"
    | "unknown"
    | "no_notification";
  messageIds?: string[];
  occurredAt?: string;
  evidence?: string;
};

export interface NotificationDeliveryProvider {
  trigger(
    idempotencyKey: string,
    payload: NotificationPayload,
    options?: { signal?: AbortSignal }
  ): void | ProviderTriggerResult | Promise<void | ProviderTriggerResult>;
  lookupOutcome?(
    workflowRunId: string,
    idempotencyKey: string
  ): Promise<ProviderDeliveryOutcome>;
  permanentlyDeleteNotification?(input: {
    messageId: string | null;
    idempotencyKey: string;
    recipientId: number;
  }): Promise<void> | void;
  archiveNotification?(messageId: string): Promise<void> | void;
  deleteUser?(userId: number): Promise<void> | void;
}

export interface NotificationFeedProvider {
  listPage(
    recipientId: number,
    options?: { cursor?: string; pageSize?: number }
  ): NotificationPage | Promise<NotificationPage>;
  markRead(
    recipientId: number,
    notificationId: string
  ): boolean | Promise<boolean>;
  markAllRead(recipientId: number): boolean | Promise<boolean>;
}

export type NotificationProvider = NotificationDeliveryProvider &
  NotificationFeedProvider;

export class UnsupportedProviderOperationError extends Error {
  constructor(readonly operation: string) {
    super(`Notification provider does not support ${operation}`);
    this.name = "UnsupportedProviderOperationError";
  }
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
