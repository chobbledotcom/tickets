import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  type MutationPhase,
  measurePhase,
  runTestStages,
} from "../../scripts/mutation/phases.ts";
import type { Status } from "../../scripts/mutation/summary.ts";

describe("mutation phases", () => {
  test("records an exact phase duration", async () => {
    const times = [10, 34];
    const measured = await measurePhase(
      "lint",
      () => Promise.resolve(7),
      () => times.shift()!,
    );
    expect(measured).toEqual({
      timing: { durationMs: 24, phase: "lint" },
      value: 7,
    });
  });

  test("skips integration tests when direct tests detect the mutant", async () => {
    const calls: MutationPhase[] = [];
    const result = await runTestStages(
      ["direct.test.ts"],
      ["integration.test.ts"],
      (phase) => {
        calls.push(phase);
        return Promise.resolve({
          status: "killed",
          timings: [{ durationMs: 4, phase }],
        });
      },
    );
    expect(calls).toEqual(["direct-tests"]);
    expect(result.status).toBe("killed");
    expect(result.timings).toEqual([{ durationMs: 4, phase: "direct-tests" }]);
  });

  test("runs integration tests for direct-test survivors", async () => {
    const calls: string[][] = [];
    const statuses: Status[] = ["survived", "killed"];
    const result = await runTestStages(
      ["direct.test.ts"],
      ["integration.test.ts"],
      (phase, files) => {
        calls.push(files);
        return Promise.resolve({
          status: statuses.shift()!,
          timings: [{ durationMs: phase === "direct-tests" ? 2 : 9, phase }],
        });
      },
    );
    expect(calls).toEqual([["direct.test.ts"], ["integration.test.ts"]]);
    expect(result).toEqual({
      status: "killed",
      timings: [
        { durationMs: 2, phase: "direct-tests" },
        { durationMs: 9, phase: "integration-tests" },
      ],
    });
  });

  test("runs integration tests directly when there are no direct tests", async () => {
    const result = await runTestStages([], ["legacy.test.ts"], (phase) =>
      Promise.resolve({
        status: "survived",
        timings: [{ durationMs: 3, phase }],
      }),
    );
    expect(result.status).toBe("survived");
    expect(result.timings[0]?.phase).toBe("integration-tests");
  });

  test("keeps a direct-test survivor when there is no integration stage", async () => {
    const result = await runTestStages(["direct.test.ts"], [], (phase) =>
      Promise.resolve({
        status: "survived",
        timings: [{ durationMs: 1, phase }],
      }),
    );
    expect(result).toEqual({
      status: "survived",
      timings: [{ durationMs: 1, phase: "direct-tests" }],
    });
  });
});
