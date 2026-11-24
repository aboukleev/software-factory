import { describe, expect, test } from "vitest";
import { validateKnockResources } from "./validate-knock-workflows";

describe("checked-in Knock resources", () => {
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
