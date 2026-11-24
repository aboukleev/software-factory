import { describe, expect, test } from "vitest";
import { formatRelativeTime } from "~/components/notification-feed";

describe("Notification Feed time", () => {
  test("refreshing the current time changes the relative label while preserving the occurrence", () => {
    const occurredAt = "2026-11-23T12:00:00.000Z";

    expect(
      formatRelativeTime(occurredAt, new Date("2026-11-23T12:00:30.000Z"))
    ).toBe("just now");
    expect(
      formatRelativeTime(occurredAt, new Date("2026-11-23T12:02:01.000Z"))
    ).toBe("2 minutes ago");
    expect(occurredAt).toBe("2026-11-23T12:00:00.000Z");
  });
});
