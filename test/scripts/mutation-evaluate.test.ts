import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  type EvaluationDeps,
  evaluateMutant,
  type FileMutationPlan,
} from "#scripts/mutation/evaluate.ts";
import type { Mutant } from "#scripts/mutation/generate.ts";
import { TEST_STATE_DIR_ENV } from "#test-utils/test-state-env.ts";

const mutant: Mutant = {
  column: 1,
  end: 4,
  line: 1,
  newOperator: "false",
  operator: "true",
  start: 0,
};

const plan = (changes: Partial<FileMutationPlan> = {}): FileMutationPlan => ({
  assets: null,
  directTestFiles: ["test/shared/example.test.ts"],
  file: "src/shared/example.ts",
  mutants: [mutant],
  original: "true",
  rebuildTestState: true,
  ...changes,
});

const setup = () => {
  const cleaned: string[] = [];
  const runs: Array<{ env: Record<string, string>; files: string[] }> = [];
  const signals: AbortSignal[] = [];
  const writes: string[] = [];
  const deps: EvaluationDeps = {
    createState: (_env) =>
      Promise.resolve({
        state: {
          cleanup: () => {
            cleaned.push("state");
            return Promise.resolve();
          },
          env: { [TEST_STATE_DIR_ENV]: "/mutant-state" },
        },
        status: "ready",
      }),
    runTests: ({ env, testFiles }, signal) => {
      runs.push({ env, files: testFiles });
      signals.push(signal);
      return Promise.resolve({ durationMs: 1, outcome: "passed" });
    },
    write: (_file, content) => {
      writes.push(content);
      return Promise.resolve();
    },
  };
  return { cleaned, deps, runs, signals, writes };
};

const runConfig = {
  batchJobs: 1,
  env: { BASE: "yes", [TEST_STATE_DIR_ENV]: "/baseline-state" },
  testFiles: [],
};

const evaluateIntegration = (
  state: ReturnType<typeof setup>,
): ReturnType<typeof evaluateMutant> =>
  evaluateMutant(
    plan(),
    mutant,
    runConfig,
    ["test/integration/example.test.ts"],
    [],
    new AbortController().signal,
    state.deps,
  );

describe("mutant evaluation", () => {
  test("shares one mutant state across the integration test stage", async () => {
    const state = setup();
    const result = await evaluateMutant(
      plan(),
      mutant,
      runConfig,
      ["test/integration/one.test.ts", "test/integration/two.test.ts"],
      [],
      new AbortController().signal,
      state.deps,
    );
    expect(result.status).toBe("survived");
    expect(state.runs).toEqual([
      { env: { BASE: "yes" }, files: ["test/shared/example.test.ts"] },
      {
        env: { [TEST_STATE_DIR_ENV]: "/mutant-state" },
        files: ["test/integration/one.test.ts", "test/integration/two.test.ts"],
      },
    ]);
    expect(state.cleaned).toEqual(["state"]);
    expect(state.signals[0]).toBe(state.signals[1]);
    expect(state.writes).toEqual([" false ", "true"]);
  });

  test("confirms a failed mutant state build against unmutated code", async () => {
    const state = setup();
    let builds = 0;
    state.deps.createState = async () => {
      builds += 1;
      return builds === 1
        ? { message: "mutant compile failed", status: "failed" }
        : {
            state: {
              cleanup: () => {
                state.cleaned.push("baseline");
                return Promise.resolve();
              },
              env: {},
            },
            status: "ready",
          };
    };
    const result = await evaluateMutant(
      plan(),
      mutant,
      runConfig,
      ["test/integration/example.test.ts"],
      [],
      new AbortController().signal,
      state.deps,
    );
    expect(result).toEqual({
      detectedBy: "test-state",
      status: "killed",
      timings: [
        { durationMs: 1, phase: "direct-tests" },
        { durationMs: expect.any(Number), phase: "test-state" },
      ],
    });
    expect(builds).toBe(2);
    expect(state.cleaned).toEqual(["baseline"]);
    expect(state.writes).toEqual([" false ", "true", "true"]);
  });

  test("fails the run when unmutated state creation also fails", async () => {
    const state = setup();
    state.deps.createState = () =>
      Promise.resolve({ message: "database unavailable", status: "failed" });
    await expect(
      evaluateMutant(
        plan(),
        mutant,
        runConfig,
        ["test/integration/example.test.ts"],
        [],
        new AbortController().signal,
        state.deps,
      ),
    ).rejects.toThrow("unmutated retry also failed");
    expect(state.writes).toEqual([" false ", "true", "true"]);
  });

  test("fails the run when an unmutated browser rebuild also fails", async () => {
    const state = setup();
    const restored: string[] = [];
    await expect(
      evaluateMutant(
        plan({
          assets: {
            rebuild: () => Promise.resolve(false),
            restore: () => {
              restored.push("assets");
              return Promise.resolve();
            },
          },
          rebuildTestState: false,
        }),
        mutant,
        runConfig,
        [],
        [],
        new AbortController().signal,
        state.deps,
      ),
    ).rejects.toThrow("Browser bundle rebuild also failed for unmutated");
    expect(state.writes).toEqual([" false ", "true", "true"]);
    expect(restored).toEqual(["assets"]);
  });

  test("counts a browser failure as a kill after an unmutated rebuild passes", async () => {
    const state = setup();
    let builds = 0;
    const result = await evaluateMutant(
      plan({
        assets: {
          rebuild: () => Promise.resolve(++builds > 1),
          restore: () => Promise.resolve(),
        },
        rebuildTestState: false,
      }),
      mutant,
      runConfig,
      [],
      [],
      new AbortController().signal,
      state.deps,
    );
    expect(result.status).toBe("killed");
    expect(builds).toBe(2);
    expect(state.runs).toEqual([]);
  });

  test("stops when mutant state creation uses the whole deadline", async () => {
    const state = setup();
    state.deps.createState = () => Promise.resolve({ status: "timed-out" });
    const result = await evaluateIntegration(state);
    expect(result).toEqual({
      detectedBy: null,
      status: "timed-out",
      timings: [
        { durationMs: 1, phase: "direct-tests" },
        { durationMs: expect.any(Number), phase: "test-state" },
      ],
    });
    expect(state.runs).toHaveLength(1);
  });

  test("stops when the unmutated state retry uses the remaining deadline", async () => {
    const state = setup();
    let builds = 0;
    state.deps.createState = () =>
      Promise.resolve(
        builds++ === 0
          ? { message: "mutant failed", status: "failed" }
          : { status: "timed-out" },
      );
    const result = await evaluateIntegration(state);
    expect(result).toMatchObject({ detectedBy: null, status: "timed-out" });
    expect(builds).toBe(2);
  });

  test("stops a failed browser build when its deadline has expired", async () => {
    const state = setup();
    const controller = new AbortController();
    const result = await evaluateMutant(
      plan({
        assets: {
          rebuild: () => {
            controller.abort();
            return Promise.resolve(false);
          },
          restore: () => Promise.resolve(),
        },
        rebuildTestState: false,
      }),
      mutant,
      runConfig,
      [],
      [],
      controller.signal,
      state.deps,
    );
    expect(result).toMatchObject({ detectedBy: null, status: "timed-out" });
  });

  test("runs tests after a successful browser rebuild", async () => {
    const state = setup();
    let restored = 0;
    const result = await evaluateMutant(
      plan({
        assets: {
          rebuild: () => Promise.resolve(true),
          restore: () => {
            restored += 1;
            return Promise.resolve();
          },
        },
        rebuildTestState: false,
      }),
      mutant,
      runConfig,
      [],
      [],
      new AbortController().signal,
      state.deps,
    );
    expect(result.status).toBe("survived");
    expect(state.runs).toHaveLength(1);
    expect(restored).toBe(1);
  });

  test("stops at the first static gate that detects a mutant", async () => {
    const state = setup();
    const result = await evaluateMutant(
      plan({
        assets: {
          rebuild: () => Promise.reject(new Error("unexpected asset build")),
          restore: () => Promise.resolve(),
        },
        rebuildTestState: false,
      }),
      mutant,
      runConfig,
      [],
      [
        {
          exit: () => Promise.resolve(0),
          label: "lint",
          phase: "lint",
          remedy: [],
        },
        {
          exit: () => Promise.resolve(1),
          label: "type-check",
          phase: "type-check",
          remedy: [],
        },
        {
          exit: () => Promise.reject(new Error("unexpected later gate")),
          label: "lint again",
          phase: "lint",
          remedy: [],
        },
      ],
      new AbortController().signal,
      state.deps,
    );
    expect(result.detectedBy).toBe("type-check");
    expect(result.timings.map(({ phase }) => phase)).toEqual([
      "lint",
      "type-check",
    ]);
    expect(state.runs).toEqual([]);
  });

  test("reports integration detection after a direct-test survivor", async () => {
    const state = setup();
    let runs = 0;
    state.deps.runTests = () =>
      Promise.resolve({
        durationMs: 1,
        outcome: runs++ === 0 ? "passed" : "failed",
      });
    const result = await evaluateMutant(
      plan({ rebuildTestState: false }),
      mutant,
      runConfig,
      ["test/integration/example.test.ts"],
      [],
      new AbortController().signal,
      state.deps,
    );
    expect(result).toMatchObject({
      detectedBy: "integration-tests",
      status: "killed",
    });
  });

  test("classifies an exception caused by the shared deadline as timed out", async () => {
    const state = setup();
    const controller = new AbortController();
    const result = await evaluateMutant(
      plan({ rebuildTestState: false }),
      mutant,
      runConfig,
      [],
      [
        {
          exit: () => {
            controller.abort();
            return Promise.reject(new DOMException("Stopped", "AbortError"));
          },
          label: "lint",
          phase: "lint",
          remedy: [],
        },
      ],
      controller.signal,
      state.deps,
    );
    expect(result).toMatchObject({ detectedBy: null, status: "timed-out" });
  });

  test("surfaces a static gate infrastructure error before its deadline", async () => {
    const state = setup();
    await expect(
      evaluateMutant(
        plan({ rebuildTestState: false }),
        mutant,
        runConfig,
        [],
        [
          {
            exit: () => Promise.reject(new Error("type checker crashed")),
            label: "type-check",
            phase: "type-check",
            remedy: [],
          },
        ],
        new AbortController().signal,
        state.deps,
      ),
    ).rejects.toThrow("type checker crashed");
  });
});
