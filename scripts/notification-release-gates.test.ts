import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

describe("Notification release gate", () => {
  test("runs every credential-free release check in the required order", () => {
    const packageJson = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8")
    ) as { scripts?: Record<string, string> };

    expect(packageJson.scripts?.["verify:notification-release"]).toBe(
      "npm run typecheck && npm run test && npm run build && npm run db:seed && npm run validate:knock && npm run test:e2e"
    );
  });
});
