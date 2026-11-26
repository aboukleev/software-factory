import { setTimeout as delay } from "node:timers/promises";
import { createNotificationOperations } from "../app/services/notificationOperations.server";

function positiveInteger(value: string | undefined, fallback: number) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`Expected a positive integer, received ${value}`);
  }
  return parsed;
}

const args = new Map(
  process.argv.slice(2).map((argument) => {
    const [name, value] = argument.split("=", 2);
    return [name, value] as const;
  })
);
const samples = positiveInteger(args.get("--samples"), 1);
const intervalMs = positiveInteger(args.get("--interval-ms"), 15_000);
const operations = createNotificationOperations();

for (let sample = 1; sample <= samples; sample += 1) {
  process.stdout.write(
    `${JSON.stringify({ sample, ...operations.snapshot() })}\n`
  );
  if (sample < samples) await delay(intervalMs);
}
