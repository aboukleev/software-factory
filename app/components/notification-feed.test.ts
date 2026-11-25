import { describe, expect, test } from "vitest";
import {
  countNewHeadItems,
  formatRelativeTime,
} from "~/components/notification-feed";

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

describe("Notification Feed reconciliation", () => {
  test("counts only newly arrived head items in provider order", () => {
    expect(
      countNewHeadItems(
        [{ id: "newest" }, { id: "new" }, { id: "existing" }],
        [{ id: "existing" }, { id: "older" }]
      )
    ).toBe(2);
  });

  test("does not treat read-state reconciliation as a new arrival", () => {
    expect(
      countNewHeadItems(
        [{ id: "existing", readAt: "2026-11-25T12:00:00.000Z" }],
        [{ id: "existing", readAt: null }]
      )
    ).toBe(0);
  });

  test("does not treat an older item revealed by head removal as new", () => {
    expect(
      countNewHeadItems(
        [{ id: "existing" }, { id: "older-revealed" }],
        [{ id: "removed-head" }, { id: "existing" }]
      )
    ).toBe(0);
  });
});
