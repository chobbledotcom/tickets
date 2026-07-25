import {
  type Envelope,
  StepDefinitionPatternType,
  TestStepResultStatus,
} from "@cucumber/messages";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { messageIssues } from "#scripts/specs/messages.ts";
import { focusedTargets, parseSpecArgs } from "#scripts/specs/options.ts";

const timestamp = { nanos: 0, seconds: 0 };

const stepDefinition = (id: string): Envelope => ({
  stepDefinition: {
    id,
    pattern: {
      source: id,
      type: StepDefinitionPatternType.CUCUMBER_EXPRESSION,
    },
    sourceReference: { uri: "compatibility.steps.ts" },
  },
});

describe("Cucumber runner", () => {
  test("rejects retries skipped steps and unused definitions", () => {
    expect(
      messageIssues(
        [
          stepDefinition("unused"),
          stepDefinition("used"),
          {
            testCase: {
              id: "case",
              pickleId: "pickle",
              testSteps: [
                { id: "hook" },
                { id: "step", stepDefinitionIds: ["used"] },
              ],
            },
          },
          {
            testCaseStarted: {
              attempt: 1,
              id: "start",
              testCaseId: "case",
              timestamp,
            },
          },
          {
            testStepFinished: {
              testCaseStartedId: "start",
              testStepId: "step",
              testStepResult: {
                duration: timestamp,
                message: "",
                status: TestStepResultStatus.SKIPPED,
              },
              timestamp,
            },
          },
        ],
        true,
      ),
    ).toEqual([
      "Cucumber retries are forbidden",
      "Cucumber step finished as SKIPPED",
      "Unused Cucumber step definition unused",
    ]);
  });

  test("allows focused runs to leave unrelated definitions unused", () => {
    expect(messageIssues([stepDefinition("unused")], false)).toEqual([]);
  });

  test("parses focused paths and a tag expression", () => {
    expect(parseSpecArgs(["specs/a.feature", "--tags", "@risk:high"])).toEqual({
      paths: ["specs/a.feature"],
      tags: "@risk:high",
    });
    expect(parseSpecArgs([])).toEqual({ paths: [] });
  });

  test("rejects missing and unknown command options", () => {
    expect(() => parseSpecArgs(["--tags"])).toThrow(
      "--tags needs a tag expression",
    );
    expect(() => parseSpecArgs(["--unknown"])).toThrow(
      "Unknown specs option --unknown",
    );
  });

  test("partitions mixed direct and Cucumber focused targets", () => {
    expect(
      focusedTargets([
        "test/shared/example.test.ts",
        "specs/example.feature",
        "--filter",
        "direct test",
        "--tags",
        "@risk:high",
      ]),
    ).toEqual({
      specPaths: ["specs/example.feature"],
      tags: "@risk:high",
      testArgs: ["test/shared/example.test.ts", "--filter", "direct test"],
    });
    expect(() => focusedTargets(["specs/example.feature", "--tags"])).toThrow(
      "--tags needs a tag expression",
    );
    expect(focusedTargets(["specs/example.feature"])).toEqual({
      specPaths: ["specs/example.feature"],
      testArgs: [],
    });
  });
});
