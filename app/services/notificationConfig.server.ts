export type NotificationConfig =
  | { mode: "fake" }
  | {
      mode: "knock";
      secretApiKey: string;
      publicApiKey: string;
      signingKey: string;
      feedChannelId: string;
    };

type NotificationEnvironment = Record<string, string | undefined>;

const REQUIRED_KNOCK_ENVIRONMENT = [
  "KNOCK_SECRET_API_KEY",
  "KNOCK_PUBLIC_API_KEY",
  "KNOCK_SIGNING_KEY",
  "KNOCK_FEED_CHANNEL_ID",
] as const;

function normalizeSigningKey(value: string) {
  const expanded = value.replaceAll("\\n", "\n");
  if (expanded.startsWith("-----BEGIN ")) return expanded;

  const decoded = Buffer.from(value, "base64").toString("utf8");
  return decoded.startsWith("-----BEGIN ") ? decoded : expanded;
}

export function loadNotificationConfig(
  environment: NotificationEnvironment = process.env
): NotificationConfig {
  const requestedMode = environment.NOTIFICATION_PROVIDER_MODE;
  const isProduction = environment.NODE_ENV === "production";

  if (isProduction && requestedMode !== "knock") {
    throw new Error("Production requires NOTIFICATION_PROVIDER_MODE=knock");
  }

  if (requestedMode === undefined || requestedMode === "fake") {
    return { mode: "fake" };
  }

  if (requestedMode !== "knock") {
    throw new Error(
      "NOTIFICATION_PROVIDER_MODE must be either fake or knock"
    );
  }

  const missing = REQUIRED_KNOCK_ENVIRONMENT.filter(
    (name) => !environment[name]?.trim()
  );
  if (missing.length > 0) {
    throw new Error(
      `Knock notification mode requires ${missing.join(", ").replace(/, ([^,]*)$/, ", and $1")}`
    );
  }

  const secretApiKey = environment.KNOCK_SECRET_API_KEY;
  const publicApiKey = environment.KNOCK_PUBLIC_API_KEY;
  const signingKey = environment.KNOCK_SIGNING_KEY;
  const feedChannelId = environment.KNOCK_FEED_CHANNEL_ID;
  if (!secretApiKey || !publicApiKey || !signingKey || !feedChannelId) {
    throw new Error("Knock notification configuration is incomplete");
  }

  return {
    mode: "knock",
    secretApiKey,
    publicApiKey,
    signingKey: normalizeSigningKey(signingKey),
    feedChannelId,
  };
}
