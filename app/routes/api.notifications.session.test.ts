import { describe, expect, test, vi } from "vitest";
import { loader } from "./api.notifications.session";

const session = vi.hoisted(() => ({ getCurrentUserId: vi.fn() }));
const controls = vi.hoisted(() => ({ feedEnabled: true }));
vi.mock("~/lib/session", () => ({
  getCurrentUserId: session.getCurrentUserId,
}));
vi.mock("~/services/notificationOperations.server", () => ({
  notificationOperations: {
    getControls: () => ({ ...controls }),
  },
}));

describe("GET /api/notifications/session", () => {
  test("returns only the current person identity without caching it", async () => {
    session.getCurrentUserId.mockResolvedValue(42);
    const response = await loader({
      request: new Request("http://cadence.test/api/notifications/session"),
    } as never);

    expect(await response.json()).toEqual({ userId: 42 });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  test("rejects an expired session", async () => {
    session.getCurrentUserId.mockResolvedValue(null);

    await expect(
      loader({
        request: new Request("http://cadence.test/api/notifications/session"),
      } as never)
    ).rejects.toMatchObject({ init: { status: 401 } });
  });
});
