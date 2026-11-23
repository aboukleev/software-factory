import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { cn } from "~/lib/utils";

export type NotificationFeedItem = {
  id: string;
  readAt: string | null;
  occurredAt: string;
  courseTitle: string;
  lessonTitle: string;
  destinationUrl: string;
  destinationAvailable: boolean;
};

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
              const isUnread =
                !optimisticAll && !item.readAt && !optimisticRead.has(item.id);
              return (
                <li key={item.id}>
                  <Link
                    to={item.destinationUrl}
                    onClick={() => markItemRead(item.id, isUnread)}
                    aria-label={`${isUnread ? "Unread. " : ""}A Student asked a Question. ${item.courseTitle}. ${item.lessonTitle}. ${new Date(item.occurredAt).toLocaleString()}`}
                    className={cn(
                      "block w-full rounded-md border p-3 text-left text-sm hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2",
                      isUnread && "font-semibold"
                    )}
                  >
                    <span className="block">A Student asked a Question.</span>
                    <span className="block text-xs text-muted-foreground">
                      {item.courseTitle} · {item.lessonTitle}
                    </span>
                    {!item.destinationAvailable && (
                      <span className="block text-xs text-muted-foreground">
                        This conversation is unavailable.
                      </span>
                    )}
                    <time
                      dateTime={item.occurredAt}
                      className="block text-xs text-muted-foreground"
                    >
                      {new Date(item.occurredAt).toLocaleString()}
                    </time>
                  </Link>
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
