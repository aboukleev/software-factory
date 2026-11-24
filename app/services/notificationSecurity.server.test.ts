import { generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, test } from "vitest";
import { createKnockUserToken } from "~/services/notificationSecurity.server";

function decodePart(value: string) {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
}

describe("Knock browser token", () => {
  test("signs a short-lived token for one person with only Feed grants", () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
    });
    const token = createKnockUserToken(
      42,
      privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      { now: new Date("2026-11-24T10:00:00.000Z") }
    );
    const parts = token.split(".");

    expect(parts).toHaveLength(3);
    const [encodedHeader, encodedPayload, encodedSignature] = parts;
    if (!encodedHeader || !encodedPayload || !encodedSignature) {
      throw new Error("Expected a three-part JWT");
    }
    expect(decodePart(encodedHeader)).toEqual({ alg: "RS256", typ: "JWT" });
    expect(decodePart(encodedPayload)).toEqual({
      sub: "42",
      iat: 1_795_514_400,
      exp: 1_795_514_700,
      explicit_grants: true,
      grants: {
        "https://api.knock.app/v1/users/42": {
          "user/feed_read": [{}],
          "user/feed_write": [{}],
        },
      },
    });
    expect(
      verify(
        "RSA-SHA256",
        Buffer.from(`${encodedHeader}.${encodedPayload}`),
        publicKey,
        Buffer.from(encodedSignature, "base64url")
      )
    ).toBe(true);
  });
});
