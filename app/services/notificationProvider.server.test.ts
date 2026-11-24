import { describe, expect, test } from "vitest";
import {
  createNotificationProvider,
  getNotificationProvider,
} from "~/services/notificationProvider.server";
import {
  fakeKnockAdapter,
  KnockNotificationProvider,
} from "~/services/notificationProvider";

describe("Notification provider selection", () => {
  test("keeps fake mode credential-free", () => {
    expect(createNotificationProvider({ mode: "fake" })).toBe(
      fakeKnockAdapter
    );
  });

  test("constructs the real adapter only from complete Knock configuration", () => {
    expect(
      createNotificationProvider({
        mode: "knock",
        secretApiKey: "sk_test_secret",
        publicApiKey: "pk_test_public",
        signingKey: "private-key",
        feedChannelId: "7e3c3b9d-a2df-4a6b-b71d-b49ef68203dc",
      })
    ).toBeInstanceOf(KnockNotificationProvider);
  });

  test("Production selection fails instead of returning the fake adapter", () => {
    expect(() =>
      getNotificationProvider({ NODE_ENV: "production" })
    ).toThrow("Production requires NOTIFICATION_PROVIDER_MODE=knock");
  });
});
