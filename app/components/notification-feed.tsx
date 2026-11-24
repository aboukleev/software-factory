import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { cn } from "~/lib/utils";

export type NotificationFeedItem = {
  id: string;
  readAt: string | null;
  occurredAt: string;
  eventKind: "question.created" | "staff-reply.created";
  actorCapacity: "student" | "instructor" | "platform_admin";
  courseTitle: string;
  lessonTitle: string;
  destinationUrl: string;
  destinationAvailable: boolean;
};

export type NotificationFeedPage = {
  items: NotificationFeedItem[];
  unreadCount: number;
  nextCursor: string | null;
};

const feedChangedEvent = "cadence:notification-feed-changed";
const unreadCountEvent = "cadence:notification-unread-count";

function notificationWording(item: NotificationFeedItem) {
  if (item.eventKind === "question.created") {
    return "A Student asked a Question.";
  }
  return item.actorCapacity === "platform_admin"
    ? "A Platform Admin replied to your Question."
    : "Your Instructor replied to your Question.";
}

export function formatRelativeTime(occurredAt: string, now = new Date()) {
  const elapsedSeconds = Math.max(
    0,
    Math.floor((now.getTime() - new Date(occurredAt).getTime()) / 1000)
  );
  if (elapsedSeconds < 60) return "just now";
  const minutes = Math.floor(elapsedSeconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

type Props = {
  initialPage: NotificationFeedPage;
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

async function requestPage(cursor?: string) {
  const search = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
  const response = await fetch(`/notifications/feed${search}`, {
    headers: { accept: "application/json" },
  });
  if (!response.ok) throw new Error("Notification Feed unavailable");
  return (await response.json()) as NotificationFeedPage;
}

function announceFeedChanged() {
  window.dispatchEvent(new Event(feedChangedEvent));
}

export function NotificationFeed({
  initialPage,
  full = false,
  onUnreadCountChange,
  onActivate,
  onReadFailure,
  onOpenFull,
}: Props) {
  const [items, setItems] = useState(initialPage.items);
  const [nextCursor, setNextCursor] = useState(initialPage.nextCursor);
  const [authoritativeUnread, setAuthoritativeUnread] = useState(
    initialPage.unreadCount
  );
  const [optimisticRead, setOptimisticRead] = useState<Set<string>>(new Set());
  const [optimisticAll, setOptimisticAll] = useState(false);
  const [markAllError, setMarkAllError] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState(false);
  const [newPage, setNewPage] = useState<NotificationFeedPage | null>(null);
  const [now, setNow] = useState(() => new Date());
  const listRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const loadMoreRef = useRef<HTMLButtonElement>(null);

  const unreadCount = useMemo(() => {
    if (optimisticAll) return 0;
    const optimisticCount = items.filter(
      (item) => !item.readAt && optimisticRead.has(item.id)
    ).length;
    return Math.max(0, authoritativeUnread - optimisticCount);
  }, [authoritativeUnread, items, optimisticAll, optimisticRead]);

  const applyHead = useCallback((page: NotificationFeedPage) => {
    setItems((current) => {
      const headIds = new Set(page.items.map((item) => item.id));
      return [
        ...page.items,
        ...current.filter((item) => !headIds.has(item.id)),
      ];
    });
    setAuthoritativeUnread(page.unreadCount);
    setOptimisticRead(new Set());
    setOptimisticAll(false);
    setRefreshError(false);
  }, []);

  const refresh = useCallback(
    async (deliberate = false) => {
      if (refreshing) return;
      setRefreshing(true);
      try {
        const page = await requestPage();
        const hasNewHead = page.items[0]?.id !== items[0]?.id;
        const awayFromTop = (listRef.current?.scrollTop ?? 0) > 32;
        if (!deliberate && awayFromTop && hasNewHead) {
          setNewPage(page);
          setAuthoritativeUnread(page.unreadCount);
          setRefreshError(false);
        } else {
          applyHead(page);
          setNewPage(null);
          if (deliberate) {
            setItems(page.items);
            setNextCursor(page.nextCursor);
            requestAnimationFrame(() => {
              listRef.current?.scrollTo({ top: 0 });
              const firstLink =
                listRef.current?.querySelector<HTMLElement>("a");
              (firstLink ?? headingRef.current)?.focus();
            });
          }
        }
      } catch {
        setRefreshError(true);
      } finally {
        setRefreshing(false);
      }
    },
    [applyHead, items, refreshing]
  );

  useEffect(() => {
    onUnreadCountChange?.(unreadCount);
    window.dispatchEvent(
      new CustomEvent(unreadCountEvent, { detail: unreadCount })
    );
  }, [onUnreadCountChange, unreadCount]);

  useEffect(() => {
    void requestPage()
      .then(applyHead)
      .catch(() => setRefreshError(true));
  }, [applyHead]);

  useEffect(() => {
    const updateTime = () => setNow(new Date());
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        updateTime();
        void refresh();
      }
    };
    const onFeedChanged = () => void refresh();
    const interval = window.setInterval(() => {
      updateTime();
      if (document.visibilityState === "visible") void refresh();
    }, 60_000);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener(feedChangedEvent, onFeedChanged);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener(feedChangedEvent, onFeedChanged);
    };
  }, [refresh]);

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
      } else {
        announceFeedChanged();
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
      setItems((current) =>
        current.map((item) => ({
          ...item,
          readAt: item.readAt ?? new Date().toISOString(),
        }))
      );
      setAuthoritativeUnread(0);
      setOptimisticAll(false);
      announceFeedChanged();
    } catch {
      setOptimisticAll(false);
      setMarkAllError(true);
    }
  }

  async function loadMore() {
    if (!nextCursor || loadingMore) return;
    const previousItemCount = items.length;
    const restoreFocus = document.activeElement === loadMoreRef.current;
    setLoadingMore(true);
    try {
      const page = await requestPage(nextCursor);
      setItems((current) => {
        const existing = new Set(current.map((item) => item.id));
        return [
          ...current,
          ...page.items.filter((item) => !existing.has(item.id)),
        ];
      });
      setNextCursor(page.nextCursor);
      setAuthoritativeUnread(page.unreadCount);
      setRefreshError(false);
      if (restoreFocus && !page.nextCursor) {
        requestAnimationFrame(() => {
          const firstAppended = listRef.current?.querySelector<HTMLElement>(
            `li:nth-child(${previousItemCount + 1}) a`
          );
          (firstAppended ?? headingRef.current)?.focus();
        });
      }
    } catch {
      setRefreshError(true);
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <div className="flex min-h-0 flex-col" data-testid="notification-feed">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h2 ref={headingRef} tabIndex={-1} className="font-semibold">
          Notification Feed
        </h2>
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
          Could not mark Notifications read. Your Feed is up to date. Course
          activity is unaffected.{" "}
          <button
            type="button"
            className="underline"
            onClick={() => void markAllRead()}
          >
            Retry
          </button>
        </p>
      )}
      {refreshError && (
        <p role="status" className="mb-2 text-sm text-destructive">
          {items.length > 0
            ? "Notifications are temporarily out of date. Course activity is unaffected."
            : "Notifications could not be loaded. Course activity is unaffected."}{" "}
          <button
            type="button"
            className="underline"
            onClick={() => void refresh()}
          >
            Retry Feed
          </button>
        </p>
      )}
      {newPage && (
        <button
          type="button"
          className="mb-2 self-start rounded-md px-2 py-1 text-sm underline"
          onClick={() => void refresh(true)}
        >
          New Notifications
        </button>
      )}
      <div
        ref={listRef}
        className={cn("min-h-0", full && "max-h-[70vh] overflow-y-auto")}
        aria-busy={refreshing || loadingMore}
      >
        {items.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            New Questions and qualifying Replies will appear here. Course
            activity is unaffected.
          </p>
        ) : (
          <ul className="space-y-2">
            {items.map((item) => {
              const wording = notificationWording(item);
              const isUnread =
                !optimisticAll && !item.readAt && !optimisticRead.has(item.id);
              const exactTime = new Date(item.occurredAt).toLocaleString();
              return (
                <li key={item.id}>
                  <Link
                    to={item.destinationUrl}
                    onClick={() => markItemRead(item.id, isUnread)}
                    aria-label={`${isUnread ? "Unread. " : ""}${wording} ${item.courseTitle}. ${item.lessonTitle}. ${exactTime}`}
                    className={cn(
                      "block w-full break-words rounded-md border p-3 text-left text-sm hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2",
                      isUnread ? "font-semibold" : "opacity-75"
                    )}
                  >
                    <span className="block">{wording}</span>
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
                      title={exactTime}
                      className="block text-xs text-muted-foreground"
                    >
                      {formatRelativeTime(item.occurredAt, now)}
                      <span className="sr-only"> ({exactTime})</span>
                    </time>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
        {nextCursor && (
          <button
            ref={loadMoreRef}
            type="button"
            disabled={loadingMore}
            onClick={() => void loadMore()}
            className="mt-3 rounded-md border px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-60"
          >
            {loadingMore ? "Loading…" : "Load more"}
          </button>
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
