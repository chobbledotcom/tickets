import {
  type Envelope,
  StepDefinitionPatternType,
  TestStepResultStatus,
} from "@cucumber/messages";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { messageIssues } from "#scripts/specs/messages.ts";
import {
  focusedTargets,
  parseSpecArgs,
  shouldCheckUnusedSteps,
  shouldRunFocusedSpecs,
} from "#scripts/specs/options.ts";
import {
  addDatabaseCleanup,
  cleanupWorld,
  requiredWorldValue,
} from "#test/specs/support/world.ts";

const timestamp = { nanos: 0, seconds: 0 };
const startedCase: Envelope = {
  testCaseStarted: {
    attempt: 0,
    id: "started",
    testCaseId: "case",
    timestamp,
  },
};

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
  test("rejects a run that selected no scenarios", () => {
    expect(messageIssues([], false)).toEqual([
      "Cucumber selected no scenarios",
    ]);
  });

  test("rejects retries", () => {
    expect(
      messageIssues(
        [
          startedCase,
          {
            testCaseStarted: {
              attempt: 1,
              id: "start",
              testCaseId: "case",
              timestamp,
            },
          },
        ],
        false,
      ),
    ).toEqual(["Cucumber retries are forbidden"]);
  });

  test("rejects skipped steps", () => {
    expect(
      messageIssues(
        [
          startedCase,
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
        false,
      ),
    ).toEqual(["Cucumber step finished as SKIPPED"]);
  });

  test("reports unused definitions", () => {
    expect(
      messageIssues(
        [
          startedCase,
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
        ],
        true,
      ),
    ).toEqual(["Unused Cucumber step definition unused"]);
  });

  test("allows focused runs to leave unrelated definitions unused", () => {
    expect(
      messageIssues([startedCase, stepDefinition("unused")], false),
    ).toEqual([]);
    expect(shouldCheckUnusedSteps({})).toBe(true);
    expect(shouldCheckUnusedSteps({ paths: ["specs/example.feature"] })).toBe(
      false,
    );
    expect(shouldCheckUnusedSteps({ tags: "@risk:high" })).toBe(false);
  });

  test("runs every scenario cleanup after one fails", async () => {
    const calls: string[] = [];
    const restoreError = new Error("restore failed");
    const error = await cleanupWorld({
      cleanup: [
        () => {
          calls.push("database");
        },
        () => {
          calls.push("provider");
          throw restoreError;
        },
      ],
    }).catch((error) => error);

    expect(calls).toEqual(["provider", "database"]);
    expect(error).toBe(restoreError);
  });

  test("clears the encryption key after database cleanup fails", async () => {
    const calls: string[] = [];
    const databaseError = new Error("database cleanup failed");
    const world = { cleanup: [] };
    addDatabaseCleanup(
      world,
      () => {
        calls.push("database");
        throw databaseError;
      },
      () => {
        calls.push("encryption key");
      },
    );

    const error = await cleanupWorld(world).catch((error) => error);
    expect(calls).toEqual(["database", "encryption key"]);
    expect(error).toBe(databaseError);
  });

  test("returns a required World value", () => {
    expect(requiredWorldValue("stored", "result")).toBe("stored");
  });

  test("rejects a missing required World value", () => {
    expect(() => requiredWorldValue(undefined, "result")).toThrow(
      "result was not set",
    );
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
    expect(() =>
      focusedTargets(["specs/example.feature", "--tags", "--unknown"]),
    ).toThrow("--tags needs a tag expression");
    expect(focusedTargets(["specs/example.feature"])).toEqual({
      specPaths: ["specs/example.feature"],
      testArgs: [],
    });
  });

  test("does not treat a tag expression as a Feature path", () => {
    const targets = focusedTargets(["--tags", "@case:payment.feature"]);
    expect(targets).toEqual({
      specPaths: [],
      tags: "@case:payment.feature",
      testArgs: [],
    });
    expect(shouldRunFocusedSpecs(targets)).toBe(true);
    expect(shouldRunFocusedSpecs({ specPaths: [] })).toBe(false);
  });

  test("keeps a Feature-like filter value with the direct test arguments", () => {
    expect(
      focusedTargets([
        "test/shared/example.test.ts",
        "--filter",
        "payment.feature",
      ]),
    ).toEqual({
      specPaths: [],
      testArgs: ["test/shared/example.test.ts", "--filter", "payment.feature"],
    });
  });

  test("keeps Feature-like Deno option and script values with direct tests", () => {
    expect(
      focusedTargets([
        "test/shared/example.test.ts",
        "--filter=payment.feature",
        "--junit-path",
        "report.feature",
        "--",
        "script.feature",
      ]),
    ).toEqual({
      specPaths: [],
      testArgs: [
        "test/shared/example.test.ts",
        "--filter=payment.feature",
        "--junit-path",
        "report.feature",
        "--",
        "script.feature",
      ],
    });
    expect(focusedTargets(["--filter"])).toEqual({
      specPaths: [],
      testArgs: ["--filter"],
    });
    expect(focusedTargets(["--filter", "--shuffle"])).toEqual({
      specPaths: [],
      testArgs: ["--filter", "--shuffle"],
    });
  });
});
