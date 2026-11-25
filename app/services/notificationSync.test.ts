import { describe, expect, test } from "vitest";
import {
  notificationChannelName,
  parseNotificationTabHint,
} from "~/services/notificationSync";

describe("Notification tab synchronization contract", () => {
  test("scopes each channel to one Cadence person", () => {
    expect(notificationChannelName(42)).toBe("cadence:notifications:42");
    expect(notificationChannelName(43)).not.toBe(notificationChannelName(42));
  });

  test("accepts content-free refresh and session-change hints only", () => {
    expect(parseNotificationTabHint({ type: "refresh" })).toEqual({
      type: "refresh",
    });
    expect(parseNotificationTabHint({ type: "session-change" })).toEqual({
      type: "session-change",
    });
    expect(
      parseNotificationTabHint({ type: "refresh", notification: "secret" })
    ).toBeNull();
    expect(parseNotificationTabHint({ type: "new-message" })).toBeNull();
  });
});
