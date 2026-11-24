import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useRevalidator } from "react-router";
import { cn } from "~/lib/utils";

export type NotificationFeedItem = {
  id: string;
  readAt: string | null;
  occurredAt: string;
  eventKind: "question.created" | "staff-reply.created";
  actorCapacity: "student" | "instructor" | "platform_admin";
  availability: "available" | "unavailable" | "temporary_failure";
  courseTitle: string | null;
  lessonTitle: string | null;
  preview: string | null;
  destinationUrl: string;
  destinationAvailable: boolean;
};

function notificationWording(item: NotificationFeedItem) {
  if (item.eventKind === "question.created") {
    return "A Student asked a Question.";
  }
  return item.actorCapacity === "platform_admin"
    ? "A Platform Admin replied to your Question."
    : "Your Instructor replied to your Question.";
}

type Props = {
  items: NotificationFeedItem[];
  full?: boolean;
  onUnreadCountChange?: (count: number) => void;
  onActivate?: () => void;
  onReadFailure?: () => void;
  onOpenFull?: () => void;
};

function mutationBody(
  intent: "mark-read" | "mark-all",
  notificationId?: string
) {
  const body = new URLSearchParams({ intent });
  if (notificationId) body.set("notificationId", notificationId);
  return body;
}

export function NotificationFeed({
  items,
  full = false,
  onUnreadCountChange,
  onActivate,
  onReadFailure,
  onOpenFull,
}: Props) {
  const [optimisticRead, setOptimisticRead] = useState<Set<string>>(new Set());
  const [optimisticAll, setOptimisticAll] = useState(false);
  const [markAllError, setMarkAllError] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const revalidator = useRevalidator();

  const unreadCount = useMemo(
    () =>
      optimisticAll
        ? 0
        : items.filter((item) => !item.readAt && !optimisticRead.has(item.id))
            .length,
    [items, optimisticAll, optimisticRead]
  );

  useEffect(() => {
    onUnreadCountChange?.(unreadCount);
  }, [onUnreadCountChange, unreadCount]);

  function markItemRead(notificationId: string, wasUnread: boolean) {
    if (wasUnread) onActivate?.();
    setOptimisticRead((current) => new Set(current).add(notificationId));
    void fetch("/notifications/read", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: mutationBody("mark-read", notificationId),
      keepalive: true,
    }).then((response) => {
      if (!response.ok) {
        if (wasUnread) onReadFailure?.();
        setOptimisticRead((current) => {
          const next = new Set(current);
          next.delete(notificationId);
          return next;
        });
      }
    });
  }

  async function markAllRead() {
    setMarkAllError(false);
    setOptimisticAll(true);
    try {
      const response = await fetch("/notifications/read", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: mutationBody("mark-all"),
      });
      if (!response.ok) throw new Error("provider rejected read mutation");
    } catch {
      setOptimisticAll(false);
      setMarkAllError(true);
    }
  }

  return (
    <div className="flex min-h-0 flex-col" data-testid="notification-feed">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h2 className="font-semibold">Notification Feed</h2>
        <span className="text-xs text-muted-foreground">
          {unreadCount} unread
        </span>
      </div>
      {unreadCount > 0 && (
        <button
          type="button"
          onClick={() => void markAllRead()}
          className="mb-2 self-start rounded-md px-2 py-1 text-sm underline focus-visible:outline-2 focus-visible:outline-offset-2"
        >
          Mark all read
        </button>
      )}
      {markAllError && (
        <p role="status" className="mb-2 text-sm text-destructive">
          Could not mark Notifications read. Your Feed is up to date.{" "}
          <button
            type="button"
            className="underline"
            onClick={() => void markAllRead()}
          >
            Retry
          </button>
        </p>
      )}
      <div
        ref={listRef}
        className={cn("min-h-0", full && "max-h-[70vh] overflow-y-auto")}
      >
        {items.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            New Questions and Replies will appear here.
          </p>
        ) : (
          <ul className="space-y-2">
            {items.map((item) => {
              const wording = notificationWording(item);
              const isUnread =
                !optimisticAll && !item.readAt && !optimisticRead.has(item.id);
              const context =
                item.availability === "available"
                  ? `${item.courseTitle}. ${item.lessonTitle}. ${item.preview ? `${item.preview}. ` : ""}`
                  : item.availability === "unavailable"
                    ? "Conversation no longer available. "
                    : "Details temporarily unavailable. ";
              const accessibleName = `${isUnread ? "Unread. " : ""}${wording} ${context}${new Date(item.occurredAt).toLocaleString()}`;
              const contents = (
                <>
                  <span className="block">{wording}</span>
                  {item.availability === "available" && (
                    <>
                      <span className="block text-xs text-muted-foreground">
                        {item.courseTitle} · {item.lessonTitle}
                      </span>
                      {item.preview && (
                        <span className="block truncate text-xs text-muted-foreground">
                          {item.preview}
                        </span>
                      )}
                    </>
                  )}
                  {item.availability === "unavailable" && (
                    <span className="block text-xs text-muted-foreground">
                      Conversation no longer available
                    </span>
                  )}
                  {item.availability === "temporary_failure" && (
                    <span className="block text-xs text-muted-foreground">
                      Details temporarily unavailable
                    </span>
                  )}
                  <time
                    dateTime={item.occurredAt}
                    className="block text-xs text-muted-foreground"
                  >
                    {new Date(item.occurredAt).toLocaleString()}
                  </time>
                </>
              );
              return (
                <li key={item.id}>
                  {item.availability === "temporary_failure" ? (
                    <div
                      role="group"
                      aria-label={accessibleName}
                      className={cn(
                        "rounded-md border p-3 text-sm",
                        isUnread && "font-semibold"
                      )}
                    >
                      {contents}
                      <button
                        type="button"
                        className="mt-1 underline focus-visible:outline-2 focus-visible:outline-offset-2"
                        onClick={() => revalidator.revalidate()}
                        disabled={revalidator.state !== "idle"}
                      >
                        Retry
                      </button>
                    </div>
                  ) : (
                    <Link
                      to={item.destinationUrl}
                      onClick={() => markItemRead(item.id, isUnread)}
                      aria-label={accessibleName}
                      className={cn(
                        "block w-full rounded-md border p-3 text-left text-sm hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2",
                        isUnread && "font-semibold"
                      )}
                    >
                      {contents}
                    </Link>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
      {!full && (
        <Link
          className="mt-3 text-sm underline"
          to="/notifications"
          onClick={onOpenFull}
        >
          Open full Notification Feed
        </Link>
      )}
    </div>
  );
}
