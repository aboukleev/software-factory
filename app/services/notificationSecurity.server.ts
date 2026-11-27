import { sign } from "node:crypto";

type TokenOptions = {
  now?: Date;
  ttlSeconds?: number;
};

function encode(value: object) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

export function createKnockUserToken(
  personId: number,
  signingKey: string,
  { now = new Date(), ttlSeconds = 300 }: TokenOptions = {}
) {
  if (!Number.isSafeInteger(personId) || personId <= 0) {
    throw new Error("A stable positive Cadence person identifier is required");
  }
  if (ttlSeconds <= 0 || ttlSeconds > 300) {
    throw new Error("Knock user tokens must expire within five minutes");
  }

  const subject = String(personId);
  const issuedAt = Math.floor(now.getTime() / 1000);
  const header = encode({ alg: "RS256", typ: "JWT" });
  const payload = encode({
    sub: subject,
    iat: issuedAt,
    exp: issuedAt + ttlSeconds,
    explicit_grants: true,
    grants: {
      [`https://api.knock.app/v1/users/${subject}`]: {
        "user/feed_read": [{}],
        "user/feed_write": [{}],
      },
    },
  });
  const unsigned = `${header}.${payload}`;
  const signature = sign("RSA-SHA256", Buffer.from(unsigned), signingKey);
  return `${unsigned}.${signature.toString("base64url")}`;
}
