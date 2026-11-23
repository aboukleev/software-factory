export type QuestionNotificationPayload = {
  eventIdentity: string;
  occurredAt: string;
  sourceCommentId: number;
  rootQuestionId: number;
  recipientId: number;
  courseId: number;
  lessonId: number;
};

export type ProviderNotification = QuestionNotificationPayload & {
  id: string;
  idempotencyKey: string;
  readAt: string | null;
};

export interface NotificationProvider {
  trigger(
    idempotencyKey: string,
    payload: QuestionNotificationPayload
  ): void | Promise<void>;
}

/** Local/test Knock substitute. It deliberately stores only the payload allowlist. */
export class FakeKnockAdapter implements NotificationProvider {
  private notifications = new Map<string, ProviderNotification>();
  private pending: Promise<void>[] = [];

  trigger(idempotencyKey: string, payload: QuestionNotificationPayload) {
    if (this.notifications.has(idempotencyKey)) return;
    this.notifications.set(idempotencyKey, {
      ...payload,
      id: idempotencyKey,
      idempotencyKey,
      readAt: null,
    });
  }

  schedule(idempotencyKey: string, payload: QuestionNotificationPayload) {
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
      .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
  }

  markRead(recipientId: number, id: string) {
    const item = this.notifications.get(id);
    if (!item || item.recipientId !== recipientId) return false;
    item.readAt ??= new Date().toISOString();
    return true;
  }
}

export const fakeKnockAdapter = new FakeKnockAdapter();
