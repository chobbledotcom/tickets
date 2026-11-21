import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { timeLimit } from "#scripts/mutation/plan.ts";
import { evaluatePlanned, plannedTwoRuns, setup } from "./fixtures.ts";

describe("planned mutant evaluation", () => {
  test("runs a planned set in order, with each run's own limit, and stops at the first failure", async () => {
    const state = setup();
    const limits: Array<number | null> = [];
    const staged: string[][] = [];
    state.deps.runTests = ({ testFiles, limitMs }) => {
      staged.push(testFiles);
      limits.push(limitMs);
      return Promise.resolve(
        staged.length === 2
          ? {
              durationMs: 2,
              failure: { batch: testFiles, output: "boom" },
              outcome: "failed",
            }
          : { durationMs: 1, outcome: "passed" },
      );
    };
    const result = await evaluatePlanned(state, plannedTwoRuns);

    expect(staged).toEqual([
      ["test/shared/example.test.ts"],
      ["test/shared/slow.test.ts"],
    ]);
    expect(limits).toEqual([
      timeLimit({ files: ["test/shared/example.test.ts"], ms: 100 }),
      timeLimit({ files: ["test/shared/slow.test.ts"], ms: 5_000 }),
    ]);
    expect(result).toEqual({
      detectedBy: "direct-tests",
      status: "killed",
      timings: [
        { durationMs: 1, phase: "direct-tests" },
        { durationMs: 2, phase: "direct-tests" },
      ],
    });
  });

  test("stops before the next planned run when the first one fails", async () => {
    const state = setup();
    let runs = 0;
    state.deps.runTests = ({ testFiles }) => {
      runs += 1;
      return Promise.resolve({
        durationMs: 1,
        failure: { batch: testFiles, output: "boom" },
        outcome: "failed",
      });
    };
    const result = await evaluatePlanned(state, plannedTwoRuns);

    expect(runs).toBe(1);
    expect(result).toMatchObject({
      detectedBy: "direct-tests",
      status: "killed",
    });
  });

  test("stops a planned set when its run is cancelled", async () => {
    const state = setup();
    let runs = 0;
    state.deps.runTests = () => {
      runs += 1;
      return Promise.resolve({ durationMs: 1, outcome: "cancelled" });
    };
    const result = await evaluatePlanned(state, plannedTwoRuns);

    expect(runs).toBe(1);
    expect(result).toEqual({
      detectedBy: null,
      status: "cancelled",
      timings: [{ durationMs: 1, phase: "direct-tests" }],
    });
  });

  test("survives without a test run when the plan is empty", async () => {
    const state = setup();
    state.deps.runTests = () => Promise.reject(new Error("no run expected"));
    const result = await evaluatePlanned(state, () => []);

    expect(result).toEqual({
      detectedBy: null,
      status: "survived",
      timings: [],
    });
  });
});
