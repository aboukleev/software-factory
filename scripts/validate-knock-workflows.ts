import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const WORKFLOW_KINDS = {
  "staff-reply-created": "staff-reply.created",
  "student-question-created": "question.created",
} as const;

const PAYLOAD_FIELDS = [
  "courseId",
  "eventIdentity",
  "eventKind",
  "lessonId",
  "occurredAt",
  "recipientId",
  "rootQuestionId",
  "sourceCommentId",
] as const;

const workflowSchema = z.object({
  $schema: z.literal("https://schemas.knock.app/cli/workflow.json"),
  name: z.string().min(1),
  description: z.string().min(1),
  trigger_frequency: z.literal("every_trigger"),
  trigger_data_json_schema: z.object({
    type: z.literal("object"),
    additionalProperties: z.literal(false),
    required: z.array(z.string()),
    properties: z.record(z.string(), z.unknown()),
  }),
  steps: z.array(
    z.object({
      channel_key: z.literal("in-app-feed"),
      channel_type: z.literal("in_app_feed"),
      ref: z.literal("in_app_feed_1"),
      template: z.object({
        "markdown_body@": z.literal("in_app_feed_1/markdown_body.md"),
      }),
      type: z.literal("channel"),
    })
  ),
});

function parseJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

export function validateKnockResources(repositoryRoot: string) {
  const workflowsRoot = resolve(repositoryRoot, "knock/workflows");
  const workflowKeys = readdirSync(workflowsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  assert.deepEqual(workflowKeys, Object.keys(WORKFLOW_KINDS).sort());

  for (const workflowKey of workflowKeys) {
    if (!(workflowKey in WORKFLOW_KINDS)) {
      throw new Error(`Unexpected Knock workflow ${workflowKey}`);
    }
    const eventKind = WORKFLOW_KINDS[
      workflowKey as keyof typeof WORKFLOW_KINDS
    ];
    const workflow = workflowSchema.parse(
      parseJson(resolve(workflowsRoot, workflowKey, "workflow.json"))
    );
    assert.equal(workflow.steps.length, 1, `${workflowKey} must be in-app only`);
    assert.deepEqual(
      [...workflow.trigger_data_json_schema.required].sort(),
      [...PAYLOAD_FIELDS]
    );
    assert.deepEqual(
      Object.keys(workflow.trigger_data_json_schema.properties).sort(),
      [...PAYLOAD_FIELDS]
    );
    assert.deepEqual(workflow.trigger_data_json_schema.properties.eventKind, {
      const: eventKind,
    });

    const template = readFileSync(
      resolve(workflowsRoot, workflowKey, "in_app_feed_1/markdown_body.md"),
      "utf8"
    );
    assert.doesNotMatch(template, /{{|{%|email|avatar|preview|title|slug/i);
  }

  assert.deepEqual(
    parseJson(resolve(repositoryRoot, "knock/feed-response-filter.json")),
    {
      actor: false,
      recipient: false,
      vars: false,
      data: { only: [...PAYLOAD_FIELDS].sort() },
    }
  );

  return { workflows: workflowKeys, payloadFields: [...PAYLOAD_FIELDS] };
}

const invokedPath = process.argv[1];
if (invokedPath && resolve(invokedPath) === fileURLToPath(import.meta.url)) {
  const result = validateKnockResources(process.cwd());
  process.stdout.write(
    `Validated ${result.workflows.length} privacy-safe Knock workflows.\n`
  );
}
