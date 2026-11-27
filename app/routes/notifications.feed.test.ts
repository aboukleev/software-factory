import { describe, expect, test, vi } from "vitest";
import { loader } from "./notifications.feed";

const feed = vi.hoisted(() => ({
  getPage: vi.fn(async () => ({ items: [], unreadCount: 0, nextCursor: null })),
}));

vi.mock("~/services/notificationAccess.server", () => ({
  requireNotificationFeedAccess: async () => ({
    userId: 7,
    canAccessCourse: vi.fn(),
  }),
}));
vi.mock("~/services/notificationFeed.server", () => ({
  getNotificationFeedPage: feed.getPage,
}));

describe("Notification Feed loader", () => {
  test("passes a schema-validated cursor to the provider-authoritative Feed", async () => {
    await loader({
      request: new Request(
        "http://cadence.test/notifications/feed?cursor=provider_cursor"
      ),
    } as never);

    expect(feed.getPage).toHaveBeenCalledWith(
      7,
      { cursor: "provider_cursor" },
      expect.any(Function)
    );
  });

  test("throws for malformed Feed search parameters", async () => {
    await expect(
      loader({
        request: new Request(
          "http://cadence.test/notifications/feed?cursor=&person=8"
        ),
      } as never)
    ).rejects.toMatchObject({ status: 400 });
  });
});
