import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { cn } from "~/lib/utils";
import {
  notificationPageEvent,
  notificationRefreshFailedEvent,
  notificationSessionClearedEvent,
  requestNotificationReconciliation,
} from "~/services/notificationSync";

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

export type NotificationFeedPage = {
  items: NotificationFeedItem[];
  unreadCount: number;
  nextCursor: string | null;
};

export function countNewHeadItems(
  next: ReadonlyArray<{ id: string; [key: string]: unknown }>,
  current: ReadonlyArray<{ id: string; [key: string]: unknown }>
) {
  const currentIds = new Set(current.map((item) => item.id));
  const firstExistingIndex = next.findIndex((item) => currentIds.has(item.id));
  return firstExistingIndex === -1 ? next.length : firstExistingIndex;
}

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
  const [newNotificationCount, setNewNotificationCount] = useState(0);
  const [liveAnnouncement, setLiveAnnouncement] = useState("");
  const [now, setNow] = useState(() => new Date());
  const listRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const loadMoreRef = useRef<HTMLButtonElement>(null);
  const itemsRef = useRef(items);
  itemsRef.current = items;

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
    setNextCursor(page.nextCursor);
    setOptimisticRead(new Set());
    setOptimisticAll(false);
    setRefreshError(false);
  }, []);

  const reconcilePage = useCallback(
    (page: NotificationFeedPage, deliberate = false) => {
      const currentItems = itemsRef.current;
      const arrivalCount = countNewHeadItems(page.items, currentItems);
      const awayFromTop = (listRef.current?.scrollTop ?? 0) > 32;
      if (!deliberate && awayFromTop && arrivalCount > 0) {
        setNewPage(page);
        setNewNotificationCount(arrivalCount);
        setAuthoritativeUnread(page.unreadCount);
        setRefreshError(false);
        return;
      }

      applyHead(page);
      setNewPage(null);
      setNewNotificationCount(0);
      if (!deliberate && arrivalCount > 0) {
        setLiveAnnouncement(
          arrivalCount === 1
            ? "New Notification"
            : `${arrivalCount} new Notifications`
        );
      }
      if (deliberate) {
        const currentIds = new Set(currentItems.map((item) => item.id));
        const firstNewId = page.items.find(
          (item) => !currentIds.has(item.id)
        )?.id;
        setItems(page.items);
        requestAnimationFrame(() => {
          listRef.current?.scrollTo({ top: 0 });
          const firstNewItem = Array.from(
            listRef.current?.querySelectorAll<HTMLElement>(
              "[data-notification-id]"
            ) ?? []
          ).find((element) => element.dataset.notificationId === firstNewId);
          const firstNewLink = firstNewItem?.querySelector<HTMLElement>("a");
          (firstNewLink ?? headingRef.current)?.focus();
        });
      }
    },
    [applyHead]
  );

  const refresh = useCallback(
    async (deliberate = false) => {
      if (refreshing) return;
      setRefreshing(true);
      try {
        const page = await requestPage();
        reconcilePage(page, deliberate);
      } catch {
        setRefreshError(true);
      } finally {
        setRefreshing(false);
      }
    },
    [reconcilePage, refreshing]
  );

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  useEffect(() => {
    onUnreadCountChange?.(unreadCount);
    window.dispatchEvent(
      new CustomEvent(unreadCountEvent, { detail: unreadCount })
    );
  }, [onUnreadCountChange, unreadCount]);

  useEffect(() => {
    const onPage = (event: Event) => {
      const page = (event as CustomEvent<NotificationFeedPage>).detail;
      if (page) reconcilePage(page);
    };
    const onSessionCleared = () => {
      setItems([]);
      setNextCursor(null);
      setAuthoritativeUnread(0);
      setOptimisticRead(new Set());
      setOptimisticAll(false);
      setNewPage(null);
      setNewNotificationCount(0);
      setLiveAnnouncement("");
    };
    const onRefreshFailed = () => setRefreshError(true);
    window.addEventListener(notificationPageEvent, onPage);
    window.addEventListener(notificationRefreshFailedEvent, onRefreshFailed);
    window.addEventListener(notificationSessionClearedEvent, onSessionCleared);
    requestNotificationReconciliation(false, "feed-open");
    void requestPage()
      .then(reconcilePage)
      .catch(() => setRefreshError(true));
    return () => {
      window.removeEventListener(notificationPageEvent, onPage);
      window.removeEventListener(
        notificationRefreshFailedEvent,
        onRefreshFailed
      );
      window.removeEventListener(
        notificationSessionClearedEvent,
        onSessionCleared
      );
    };
  }, [reconcilePage]);

  useEffect(() => {
    const updateTime = () => setNow(new Date());
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        updateTime();
        void refresh();
      }
    };
    const interval = window.setInterval(() => {
      updateTime();
    }, 60_000);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
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
      }
      requestNotificationReconciliation(true, "read-mutation");
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
      requestNotificationReconciliation(true, "read-mutation");
    } catch {
      setOptimisticAll(false);
      setMarkAllError(true);
      requestNotificationReconciliation(true, "read-mutation");
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
    <div
      className="flex min-h-0 flex-1 flex-col"
      data-testid="notification-feed"
    >
      <div className="mb-2 flex min-h-11 items-center justify-between gap-3 pr-11">
        <h2 ref={headingRef} tabIndex={-1} className="font-semibold">
          Notification Feed
        </h2>
        <span className="text-xs text-muted-foreground">
          {unreadCount} unread
        </span>
      </div>
      <p
        className="sr-only"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {liveAnnouncement}
      </p>
      {unreadCount > 0 && (
        <button
          type="button"
          onClick={() => void markAllRead()}
          className="mb-2 min-h-11 self-start rounded-md px-3 py-2 text-sm underline focus-visible:outline-2 focus-visible:outline-offset-2"
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
            className="min-h-11 rounded-md px-2 underline focus-visible:outline-2 focus-visible:outline-offset-2"
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
            className="min-h-11 rounded-md px-2 underline focus-visible:outline-2 focus-visible:outline-offset-2"
            onClick={() => void refresh()}
          >
            Retry Feed
          </button>
        </p>
      )}
      {newPage && (
        <button
          type="button"
          className="mb-2 min-h-11 self-start rounded-md px-3 py-2 text-sm underline focus-visible:outline-2 focus-visible:outline-offset-2"
          onClick={() => void refresh(true)}
        >
          {newNotificationCount > 1
            ? `${newNotificationCount} New Notifications`
            : "New Notification"}
        </button>
      )}
      <div
        ref={listRef}
        className={cn(
          "min-h-0 overflow-y-auto",
          full ? "max-h-[70vh]" : "max-h-[60vh]"
        )}
        aria-busy={refreshing || loadingMore}
      >
        {(refreshing || loadingMore) && (
          <p className="sr-only" role="status" aria-live="polite">
            {refreshing
              ? "Updating Notifications"
              : "Loading more Notifications"}
          </p>
        )}
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
              const relativeTime = formatRelativeTime(item.occurredAt, now);
              const contents = (
                <>
                  {isUnread && <span className="sr-only">Unread. </span>}
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
                    title={exactTime}
                    className="block text-xs text-muted-foreground"
                  >
                    {relativeTime}
                    <span className="sr-only"> ({exactTime})</span>
                  </time>
                </>
              );
              return (
                <li key={item.id} data-notification-id={item.id}>
                  {item.availability === "temporary_failure" ? (
                    <div
                      role="group"
                      className={cn(
                        "rounded-md border p-3 text-sm",
                        isUnread && "font-semibold"
                      )}
                    >
                      {contents}
                      <button
                        type="button"
                        className="mt-1 min-h-11 rounded-md px-2 underline focus-visible:outline-2 focus-visible:outline-offset-2"
                        onClick={() => void refresh()}
                        disabled={refreshing}
                      >
                        Retry
                      </button>
                    </div>
                  ) : (
                    <Link
                      to={item.destinationUrl}
                      onClick={() => markItemRead(item.id, isUnread)}
                      className={cn(
                        "block min-h-11 w-full rounded-md border p-3 text-left text-sm hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 forced-colors:border-[ButtonBorder]",
                        isUnread ? "font-semibold" : "font-normal"
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
        {nextCursor && (
          <button
            ref={loadMoreRef}
            type="button"
            disabled={loadingMore}
            onClick={() => void loadMore()}
            className="mt-3 min-h-11 rounded-md border px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-60"
          >
            {loadingMore ? "Loading…" : "Load more"}
          </button>
        )}
      </div>
      {!full && (
        <Link
          className="mt-3 flex min-h-11 items-center self-start rounded-md px-1 text-sm underline focus-visible:outline-2 focus-visible:outline-offset-2"
          to="/notifications"
          onClick={onOpenFull}
        >
          Open full Notification Feed
        </Link>
      )}
    </div>
  );
}
