import { describe, expect, test } from "vitest";
import { loadNotificationConfig } from "~/services/notificationConfig.server";

describe("Notification provider configuration", () => {
  test("uses the credential-free fake provider outside Production", () => {
    expect(loadNotificationConfig({ NODE_ENV: "development" })).toEqual({
      mode: "fake",
    });
  });

  test("fails with every missing credential when real-provider mode is selected", () => {
    expect(() =>
      loadNotificationConfig({
        NODE_ENV: "development",
        NOTIFICATION_PROVIDER_MODE: "knock",
      })
    ).toThrowError(
      "Knock notification mode requires KNOCK_SECRET_API_KEY, KNOCK_PUBLIC_API_KEY, KNOCK_SIGNING_KEY, and KNOCK_FEED_CHANNEL_ID"
    );
  });

  test("Production cannot select or fall back to the fake provider", () => {
    expect(() => loadNotificationConfig({ NODE_ENV: "production" })).toThrow(
      "Production requires NOTIFICATION_PROVIDER_MODE=knock"
    );
    expect(() =>
      loadNotificationConfig({
        NODE_ENV: "production",
        NOTIFICATION_PROVIDER_MODE: "fake",
      })
    ).toThrow("Production requires NOTIFICATION_PROVIDER_MODE=knock");
  });

  test("loads an explicitly configured real provider", () => {
    expect(
      loadNotificationConfig({
        NODE_ENV: "production",
        NOTIFICATION_PROVIDER_MODE: "knock",
        KNOCK_SECRET_API_KEY: "sk_test_secret",
        KNOCK_PUBLIC_API_KEY: "pk_test_public",
        KNOCK_SIGNING_KEY: "private-key",
        KNOCK_FEED_CHANNEL_ID: "7e3c3b9d-a2df-4a6b-b71d-b49ef68203dc",
      })
    ).toEqual({
      mode: "knock",
      secretApiKey: "sk_test_secret",
      publicApiKey: "pk_test_public",
      signingKey: "private-key",
      feedChannelId: "7e3c3b9d-a2df-4a6b-b71d-b49ef68203dc",
    });
  });

  test("decodes Knock's single-line base64 signing key format", () => {
    const signingKey = [
      "-----BEGIN PRIVATE KEY-----",
      "test-key-material",
      "-----END PRIVATE KEY-----",
      "",
    ].join("\n");

    expect(
      loadNotificationConfig({
        NODE_ENV: "development",
        NOTIFICATION_PROVIDER_MODE: "knock",
        KNOCK_SECRET_API_KEY: "sk_test_secret",
        KNOCK_PUBLIC_API_KEY: "pk_test_public",
        KNOCK_SIGNING_KEY: Buffer.from(signingKey).toString("base64"),
        KNOCK_FEED_CHANNEL_ID: "7e3c3b9d-a2df-4a6b-b71d-b49ef68203dc",
      })
    ).toMatchObject({ signingKey });
  });
});
