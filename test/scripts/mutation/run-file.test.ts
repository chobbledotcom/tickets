import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import type { FileMutationPlan } from "#scripts/mutation/evaluate.ts";
import type { Mutant } from "#scripts/mutation/generate.ts";
import { mutantKey } from "#scripts/mutation/ignore.ts";
import {
  type FileRunDeps,
  type FileRunOptions,
  type MutantLoopContext,
  runFileMutants,
} from "#scripts/mutation/run-file.ts";
import type { StaticEvaluation } from "#scripts/mutation/static.ts";
import type { Status } from "#scripts/mutation/summary.ts";

const mutants = Array.from(
  { length: 4 },
  (_, index): Mutant => ({
    anchor: `mutant-${index}`,
    column: 1,
    end: 4,
    line: 1,
    newOperator: index % 2 === 0 ? "false" : "null",
    operator: "true",
    start: 0,
  }),
);

const plan: FileMutationPlan = {
  assets: null,
  directTestFiles: ["test/source.test.ts"],
  file: "/work/source.ts",
  mutants,
  original: "true",
  rebuildTestState: false,
};

const emptyCounts = (): Record<Status, number> => ({
  ignored: 0,
  killed: 0,
  survived: 0,
  "timed-out": 0,
});

const options = (changes: Partial<FileRunOptions> = {}): FileRunOptions => ({
  abortSignal: new AbortController().signal,
  batchJobs: 2,
  ignoreList: { entries: [], keys: new Set() },
  integrationTestFiles: ["test/integration/source.test.ts"],
  isAborted: () => false,
  originals: new Map(),
  results: [],
  staticJobs: 3,
  staticWorkerParent: "/workers",
  testFiles: ["test/source.test.ts"],
  ...changes,
});

const context = (
  changes: Partial<MutantLoopContext> = {},
): MutantLoopContext => ({
  counts: emptyCounts(),
  gates: [],
  perMutantTimeout: 100,
  totalMutants: plan.mutants.length,
  ...changes,
});

const staticResult = (
  mutant: Mutant,
  status: StaticEvaluation["status"],
  deadlineAt = 95,
  durationMs = 5,
): StaticEvaluation => ({
  deadlineAt,
  detectedBy: status === "killed" ? "lint" : null,
  mutant,
  status,
  timings: [{ durationMs, phase: "lint" }],
});

const dependencies = (changes: Partial<FileRunDeps> = {}): FileRunDeps => ({
  evaluateStatic: () => Promise.resolve([]),
  evaluateTests: () => Promise.reject(new Error("Unexpected test evaluation")),
  now: () => 0,
  timeoutSignal: () => new AbortController().signal,
  ...changes,
});

const withStaticSurvivor = (changes: Partial<FileRunDeps> = {}): FileRunDeps =>
  dependencies({
    evaluateStatic: () =>
      Promise.resolve([staticResult(mutants[0]!, "survived")]),
    ...changes,
  });

const expectNoResult = async (
  opts: FileRunOptions,
  deps: FileRunDeps,
): Promise<void> => {
  await runFileMutants(plan, opts, context(), deps);
  expect(opts.results).toEqual([]);
  expect(opts.originals.size).toBe(0);
};

describe("mutation file coordinator", () => {
  test("reports ordered static and test outcomes", async () => {
    const opts = options({
      ignoreList: {
        entries: [],
        keys: new Set([mutantKey(plan.file, mutants[3]!)]),
      },
    });
    const ctx = context();
    const tested: string[] = [];
    const timeouts: number[] = [];
    const lines: string[] = [];
    using _log = stub(console, "log", (line: unknown) => {
      lines.push(String(line));
    });
    const deps = dependencies({
      evaluateStatic: (_plan, _gates, config) => {
        expect(config.jobs).toBe(3);
        expect(config.perMutantTimeout).toBe(100);
        expect(config.workerParent).toBe("/workers");
        return Promise.resolve([
          staticResult(mutants[0]!, "killed"),
          staticResult(mutants[1]!, "survived", 95),
          staticResult(mutants[2]!, "survived", -1),
          staticResult(mutants[3]!, "survived", 80),
        ]);
      },
      evaluateTests: (
        _plan,
        mutant,
        run,
        integrationFiles,
        signal,
        timings,
      ) => {
        tested.push(mutant.anchor);
        expect(run.batchJobs).toBe(2);
        expect(run.testFiles).toEqual(opts.testFiles);
        expect(integrationFiles).toEqual(opts.integrationTestFiles);
        expect(signal.aborted).toBe(false);
        return Promise.resolve({
          detectedBy: null,
          status: "survived",
          timings: [...timings, { durationMs: 4, phase: "direct-tests" }],
        });
      },
      timeoutSignal: (milliseconds) => {
        timeouts.push(milliseconds);
        return new AbortController().signal;
      },
    });

    await runFileMutants(plan, opts, ctx, deps);

    expect(
      opts.results.map(({ mutant, status }) => [mutant.anchor, status]),
    ).toEqual([
      ["mutant-0", "killed"],
      ["mutant-1", "survived"],
      ["mutant-2", "timed-out"],
      ["mutant-3", "ignored"],
    ]);
    expect(tested).toEqual(["mutant-1", "mutant-3"]);
    expect(timeouts).toEqual([95, 80]);
    expect(ctx.counts).toEqual({
      ignored: 1,
      killed: 1,
      survived: 1,
      "timed-out": 1,
    });
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("last survived");
    expect(lines[1]).toContain("last timed-out");
    expect(lines[2]).toContain("last ignored");
    expect(opts.originals.size).toBe(0);
  });

  test("keeps a mutant deadline running while earlier tests run", async () => {
    const opts = options();
    let now = 0;
    const tested: string[] = [];
    const timeouts: number[] = [];
    const deps = dependencies({
      evaluateStatic: () =>
        Promise.resolve([
          staticResult(mutants[0]!, "survived", 100),
          staticResult(mutants[1]!, "survived", 100),
        ]),
      evaluateTests: (_plan, mutant) => {
        tested.push(mutant.anchor);
        now = 120;
        return Promise.resolve({
          detectedBy: null,
          status: "survived",
          timings: [],
        });
      },
      now: () => now,
      timeoutSignal: (milliseconds) => {
        timeouts.push(milliseconds);
        return new AbortController().signal;
      },
    });

    await runFileMutants(plan, opts, context(), deps);

    expect(tested).toEqual(["mutant-0"]);
    expect(timeouts).toEqual([100]);
    expect(opts.results.map(({ status }) => status)).toEqual([
      "survived",
      "timed-out",
    ]);
  });

  test("stops before test evaluation when the run is aborted", async () => {
    const opts = options({ isAborted: () => true });
    const deps = withStaticSurvivor();

    await expectNoResult(opts, deps);
  });

  test("drops a test result when the run aborts during evaluation", async () => {
    let aborted = false;
    const opts = options({ isAborted: () => aborted });
    const deps = withStaticSurvivor({
      evaluateTests: () => {
        aborted = true;
        return Promise.resolve({
          detectedBy: null,
          status: "survived",
          timings: [],
        });
      },
    });

    await expectNoResult(opts, deps);
  });

  test("cleans source tracking when static evaluation fails", async () => {
    const opts = options();
    const deps = dependencies({
      evaluateStatic: () => Promise.reject(new Error("static worker failed")),
    });

    await expect(runFileMutants(plan, opts, context(), deps)).rejects.toThrow(
      "static worker failed",
    );
    expect(opts.originals.size).toBe(0);
  });

  test("cleans source tracking when test evaluation fails", async () => {
    const opts = options();
    const deps = withStaticSurvivor({
      evaluateTests: () => Promise.reject(new Error("test runner failed")),
    });

    await expect(runFileMutants(plan, opts, context(), deps)).rejects.toThrow(
      "test runner failed",
    );
    expect(opts.originals.size).toBe(0);
  });
});
