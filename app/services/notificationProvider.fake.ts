import type {
  NotificationPage,
  NotificationPayload,
  NotificationProvider,
  ProviderNotification,
} from "./notificationProvider.contract";
import { UnsupportedProviderOperationError } from "./notificationProvider.contract";

/** Local/test Knock substitute. It stores only the approved payload allowlist. */
export class FakeKnockAdapter implements NotificationProvider {
  private notifications = new Map<string, ProviderNotification>();
  private archived = new Set<string>();
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
      .then(() => this.trigger(idempotencyKey, payload))
      .then(
        () => undefined,
        () => undefined
      );
    this.pending.push(work);
  }

  async settled() {
    await Promise.all(this.pending);
    this.pending = [];
  }

  list(recipientId: number) {
    return [...this.notifications.values()]
      .filter(
        (item) =>
          item.recipientId === recipientId && !this.archived.has(item.id)
      )
      .reverse();
  }

  listArchived(recipientId: number) {
    return [...this.notifications.values()].filter(
      (item) => item.recipientId === recipientId && this.archived.has(item.id)
    );
  }

  permanentlyDeleteNotification(input: {
    messageId: string | null;
    idempotencyKey: string;
  }) {
    const id = input.messageId ?? input.idempotencyKey;
    this.notifications.delete(id);
    this.archived.delete(id);
  }

  archiveNotification(messageId: string) {
    if (!this.notifications.has(messageId))
      throw new Error(`Notification ${messageId} was not found`);
    this.archived.add(messageId);
  }

  deleteUser(userId: number) {
    for (const [id, item] of this.notifications) {
      if (item.recipientId === userId) {
        this.notifications.delete(id);
        this.archived.delete(id);
      }
    }
  }

  disablePermanentMessageDeletion() {
    this.permanentlyDeleteNotification = () => {
      throw new UnsupportedProviderOperationError(
        "per-message permanent deletion"
      );
    };
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
    this.archived.clear();
    this.workflowRuns.clear();
    this.pending = [];
    this.rejectNextRead = false;
    this.rejectNextMarkAll = false;
  }
}

export const fakeKnockAdapter = new FakeKnockAdapter();
