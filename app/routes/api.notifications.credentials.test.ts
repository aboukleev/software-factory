import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { loader } from "./api.notifications.credentials";

const session = vi.hoisted(() => ({ getCurrentUserId: vi.fn() }));
vi.mock("~/lib/session", () => ({
  getCurrentUserId: session.getCurrentUserId,
}));

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });

beforeEach(() => {
  session.getCurrentUserId.mockResolvedValue(42);
  vi.stubEnv("NOTIFICATION_PROVIDER_MODE", "knock");
  vi.stubEnv("KNOCK_SECRET_API_KEY", "sk_test_secret");
  vi.stubEnv("KNOCK_PUBLIC_API_KEY", "pk_test_public");
  vi.stubEnv(
    "KNOCK_SIGNING_KEY",
    Buffer.from(
      privateKey.export({ type: "pkcs8", format: "pem" }).toString()
    ).toString("base64")
  );
  vi.stubEnv("KNOCK_FEED_CHANNEL_ID", "7e3c3b9d-a2df-4a6b-b71d-b49ef68203dc");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("GET /api/notifications/credentials", () => {
  test("issues browser-safe credentials only for the authenticated person", async () => {
    const response = await loader({
      request: new Request("http://cadence.test/api/notifications/credentials"),
    } as never);
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body).toEqual({
      userId: "42",
      publicApiKey: "pk_test_public",
      feedChannelId: "7e3c3b9d-a2df-4a6b-b71d-b49ef68203dc",
      userToken: expect.any(String),
    });
    expect(JSON.stringify(body)).not.toContain("sk_test_secret");
    expect(JSON.stringify(body)).not.toContain("PRIVATE KEY");
  });

  test("rejects an unauthenticated request", async () => {
    session.getCurrentUserId.mockResolvedValue(null);

    await expect(
      loader({
        request: new Request(
          "http://cadence.test/api/notifications/credentials"
        ),
      } as never)
    ).rejects.toMatchObject({ init: { status: 401 } });
  });
});
