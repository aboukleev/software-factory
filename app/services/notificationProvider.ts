export type NotificationPayload = {
  eventIdentity: string;
  eventKind: "question.created" | "staff-reply.created";
  actorCapacity: "student" | "instructor" | "platform_admin";
  occurredAt: string;
  sourceCommentId: number;
  rootQuestionId: number;
  recipientId: number;
  courseId: number;
  lessonId: number;
};

export type ProviderNotification = NotificationPayload & {
  id: string;
  idempotencyKey: string;
  readAt: string | null;
};

export interface NotificationProvider {
  trigger(
    idempotencyKey: string,
    payload: NotificationPayload
  ): void | Promise<void>;
}

export type NotificationPage = {
  items: ProviderNotification[];
  unreadCount: number;
  nextCursor: string | null;
};

/** Local/test Knock substitute. It deliberately stores only the payload allowlist. */
export class FakeKnockAdapter implements NotificationProvider {
  private notifications = new Map<string, ProviderNotification>();
  private pending: Promise<void>[] = [];
  private rejectNextRead = false;
  private rejectNextMarkAll = false;

  trigger(idempotencyKey: string, payload: NotificationPayload) {
    if (this.notifications.has(idempotencyKey)) return;
    this.notifications.set(idempotencyKey, {
      ...payload,
      id: idempotencyKey,
      idempotencyKey,
      readAt: null,
    });
  }

  schedule(idempotencyKey: string, payload: NotificationPayload) {
    const work = Promise.resolve()
      .then(() => this.trigger(idempotencyKey, payload))
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
    this.pending = [];
    this.rejectNextRead = false;
    this.rejectNextMarkAll = false;
  }
}

export const fakeKnockAdapter = new FakeKnockAdapter();
