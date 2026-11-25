import { useEffect, useRef } from "react";
import type { NotificationFeedPage } from "~/components/notification-feed";
import {
  notificationChannelName,
  notificationPageEvent,
  notificationRefreshEvent,
  notificationRefreshFailedEvent,
  notificationSessionClearedEvent,
  parseNotificationTabHint,
  publishNotificationPage,
} from "~/services/notificationSync";

type Credentials = {
  userId: string;
  publicApiKey: string;
  feedChannelId: string;
  userToken: string;
};

type Props = {
  personId: number | null;
  initialPage: NotificationFeedPage;
  onPage(page: NotificationFeedPage): void;
};

async function requestPage(signal?: AbortSignal) {
  const response = await fetch("/notifications/feed", {
    headers: { accept: "application/json" },
    signal,
  });
  if (!response.ok) throw new Error("Notification Feed unavailable");
  return (await response.json()) as NotificationFeedPage;
}

async function requestSessionIdentity(signal?: AbortSignal) {
  const response = await fetch("/api/notifications/session", {
    headers: { accept: "application/json" },
    signal,
  });
  if (response.status === 401) return null;
  if (!response.ok) throw new Error("Notification session unavailable");
  const body = (await response.json()) as { userId?: unknown };
  return typeof body.userId === "number" ? body.userId : null;
}

async function requestCredentials(signal?: AbortSignal) {
  const response = await fetch("/api/notifications/credentials", {
    headers: { accept: "application/json" },
    signal,
  });
  if (!response.ok) return null;
  return (await response.json()) as Credentials;
}

/**
 * Owns the person-scoped synchronization lifecycle for the application shell.
 * Browser hints never carry or apply Notification content; every hint causes a
 * fresh request to Cadence's authorized Feed endpoint.
 */
export function NotificationSync({ personId, initialPage, onPage }: Props) {
  const onPageRef = useRef(onPage);
  onPageRef.current = onPage;

  useEffect(() => {
    if (!personId) return;

    let disposed = false;
    let reconciling: Promise<void> | null = null;
    let rerun = false;
    const abortController = new AbortController();
    const channel =
      typeof BroadcastChannel === "undefined"
        ? null
        : new BroadcastChannel(notificationChannelName(personId));

    const clearSession = () => {
      const emptyPage = { items: [], unreadCount: 0, nextCursor: null };
      onPageRef.current(emptyPage);
      window.dispatchEvent(new Event(notificationSessionClearedEvent));
    };

    const reconcile = () => {
      if (disposed) return Promise.resolve();
      if (reconciling) {
        rerun = true;
        return reconciling;
      }
      reconciling = requestPage(abortController.signal)
        .then((page) => {
          if (disposed) return;
          onPageRef.current(page);
          publishNotificationPage(page);
        })
        .catch((error: unknown) => {
          if (!(error instanceof DOMException && error.name === "AbortError")) {
            window.dispatchEvent(
              new CustomEvent(notificationRefreshFailedEvent)
            );
          }
        })
        .finally(() => {
          reconciling = null;
          if (rerun && !disposed) {
            rerun = false;
            void reconcile();
          }
        });
      return reconciling;
    };

    const validateIdentityAndReconcile = async () => {
      try {
        const currentPersonId = await requestSessionIdentity(
          abortController.signal
        );
        if (disposed) return;
        if (currentPersonId !== personId) {
          clearSession();
          channel?.postMessage({ type: "session-change" });
          window.location.reload();
          return;
        }
        await reconcile();
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          await reconcile();
        }
      }
    };

    const onRefresh = (event: Event) => {
      const detail = (event as CustomEvent<unknown>).detail;
      if (
        detail &&
        typeof detail === "object" &&
        "broadcast" in detail &&
        detail.broadcast === true
      ) {
        channel?.postMessage({ type: "refresh" });
      }
      void reconcile();
    };
    const onFocus = () => void validateIdentityAndReconcile();
    const onOnline = () => void validateIdentityAndReconcile();
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        void validateIdentityAndReconcile();
      }
    };
    channel?.addEventListener("message", (event) => {
      const hint = parseNotificationTabHint(event.data);
      if (hint?.type === "refresh") void reconcile();
      if (hint?.type === "session-change") {
        void validateIdentityAndReconcile();
      }
    });

    onPageRef.current(initialPage);
    void reconcile();
    window.addEventListener(notificationRefreshEvent, onRefresh);
    window.addEventListener("focus", onFocus);
    window.addEventListener("online", onOnline);
    document.addEventListener("visibilitychange", onVisibility);
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") void reconcile();
    }, 60_000);

    let disposeRealtime = () => {};
    void requestCredentials(abortController.signal)
      .then(async (credentials) => {
        if (!credentials || disposed || credentials.userId !== String(personId))
          return;
        const { default: Knock } = await import("@knocklabs/client");
        if (disposed) return;
        const knock = new Knock(credentials.publicApiKey, {
          disconnectOnPageHidden: true,
        });
        knock.authenticate({ id: credentials.userId }, credentials.userToken, {
          identificationStrategy: "skip",
          onUserTokenExpiring: async () => {
            const refreshed = await requestCredentials(
              abortController.signal
            ).catch(() => null);
            if (!refreshed || refreshed.userId !== String(personId)) {
              clearSession();
              return;
            }
            return refreshed.userToken;
          },
        });
        const feed = knock.feeds.initialize(credentials.feedChannelId, {
          mode: "compact",
        });
        // Deliberately discard the SDK payload. The event is a lossy metadata
        // hint; Cadence's authorized Feed response remains authoritative.
        const onRealtimeHint = () => {
          channel?.postMessage({ type: "refresh" });
          void reconcile();
        };
        feed.on("items.received.realtime", onRealtimeHint);
        feed.listenForUpdates();
        disposeRealtime = () => {
          feed.off("items.received.realtime", onRealtimeHint);
          feed.dispose();
          knock.logout();
        };
        if (disposed) disposeRealtime();
      })
      .catch(() => undefined);

    return () => {
      disposed = true;
      clearSession();
      channel?.postMessage({ type: "session-change" });
      abortController.abort();
      disposeRealtime();
      window.clearInterval(interval);
      window.removeEventListener(notificationRefreshEvent, onRefresh);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("online", onOnline);
      document.removeEventListener("visibilitychange", onVisibility);
      channel?.close();
    };
  }, [initialPage, personId]);

  return null;
}

export { notificationPageEvent };
