import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { validateKnockResources } from "./validate-knock-workflows";

function withWorkflowFixture(run: (root: string) => void) {
  const root = mkdtempSync(resolve(tmpdir(), "cadence-knock-workflows-"));
  cpSync(resolve(process.cwd(), "knock"), resolve(root, "knock"), {
    recursive: true,
  });

  try {
    run(root);
  } finally {
    rmSync(root, { recursive: true });
  }
}

function updateWorkflows(
  root: string,
  update: (workflow: Record<string, unknown>) => void
) {
  for (const workflowKey of [
    "staff-reply-created",
    "student-question-created",
  ]) {
    const path = resolve(root, "knock/workflows", workflowKey, "workflow.json");
    const workflow = JSON.parse(readFileSync(path, "utf8")) as Record<
      string,
      unknown
    >;
    update(workflow);
    writeFileSync(path, `${JSON.stringify(workflow, null, 2)}\n`);
  }
}

describe("checked-in Knock resources", () => {
  test("accept the provider channel key with exactly one supported action field", () => {
    withWorkflowFixture((root) => {
      updateWorkflows(root, (workflow) => {
        const [step] = workflow.steps as Array<Record<string, unknown>>;
        step.channel_key = "in-app";
        step.template = {
          action_url: "https://cadence.example/notifications",
          "markdown_body@": "in_app_feed_1/markdown_body.md",
        };
      });

      expect(() => validateKnockResources(root)).not.toThrow();
    });
  });

  test.each([
    ["the old channel key", { channel_key: "in-app-feed" }],
    ["no action field", { template: {} }],
    [
      "both supported action fields",
      {
        template: {
          action_buttons: [{ label: "Open", url: "https://cadence.example" }],
          action_url: "https://cadence.example/notifications",
        },
      },
    ],
  ])("reject %s", (_name, invalidStep) => {
    withWorkflowFixture((root) => {
      updateWorkflows(root, (workflow) => {
        const [step] = workflow.steps as Array<Record<string, unknown>>;
        step.channel_key = "in-app";
        step.template = {
          action_url: "https://cadence.example/notifications",
          "markdown_body@": "in_app_feed_1/markdown_body.md",
        };
        Object.assign(step, invalidStep);
        if ("template" in invalidStep) {
          step.template = {
            ...(invalidStep.template as Record<string, unknown>),
            "markdown_body@": "in_app_feed_1/markdown_body.md",
          };
        }
      });

      expect(() => validateKnockResources(root)).toThrow();
    });
  });

  test("contain exactly two in-app-only workflows with privacy-safe schemas and templates", () => {
    expect(validateKnockResources(process.cwd())).toEqual({
      workflows: ["staff-reply-created", "student-question-created"],
      payloadFields: [
        "courseId",
        "eventIdentity",
        "eventKind",
        "lessonId",
        "occurredAt",
        "recipientId",
        "rootQuestionId",
        "sourceCommentId",
      ],
    });
  });
});
