import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import type { FileMutationPlan } from "#scripts/mutation/evaluate.ts";
import type { Mutant } from "#scripts/mutation/generate.ts";
import { mutantKey } from "#scripts/mutation/ignore.ts";
import {
  type FileRunOptions,
  runFileMutants,
} from "#scripts/mutation/run-file.ts";
import type { StaticEvaluation } from "#scripts/mutation/static.ts";
import type { Status } from "#scripts/mutation/summary.ts";

type FileRunDeps = NonNullable<Parameters<typeof runFileMutants>[3]>;
type MutantLoopContext = Parameters<typeof runFileMutants>[2];

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
  totalMutants: plan.mutants.length,
  ...changes,
});

const staticResult = (
  mutant: Mutant,
  status: StaticEvaluation["status"],
  durationMs = 5,
): StaticEvaluation => ({
  detectedBy: status === "killed" ? "lint" : null,
  mutant,
  status,
  timings: [{ durationMs, phase: "lint" }],
});

const dependencies = (changes: Partial<FileRunDeps> = {}): FileRunDeps => ({
  evaluateStatic: () => Promise.resolve([]),
  evaluateTests: () => Promise.reject(new Error("Unexpected test evaluation")),
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
    const lines: string[] = [];
    using _log = stub(console, "log", (line: unknown) => {
      lines.push(String(line));
    });
    const deps = dependencies({
      evaluateStatic: (_plan, _gates, config) => {
        expect(config.jobs).toBe(3);
        expect(config.workerParent).toBe("/workers");
        return Promise.resolve([
          staticResult(mutants[0]!, "killed"),
          staticResult(mutants[1]!, "survived"),
          staticResult(mutants[2]!, "survived"),
          staticResult(mutants[3]!, "survived"),
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
    });

    await runFileMutants(plan, opts, ctx, deps);

    expect(
      opts.results.map(({ mutant, status }) => [mutant.anchor, status]),
    ).toEqual([
      ["mutant-0", "killed"],
      ["mutant-1", "survived"],
      ["mutant-2", "survived"],
      ["mutant-3", "ignored"],
    ]);
    expect(tested).toEqual(["mutant-1", "mutant-2", "mutant-3"]);
    expect(ctx.counts).toEqual({ ignored: 1, killed: 1, survived: 2 });
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("last survived");
    expect(lines[1]).toContain("last survived");
    expect(lines[2]).toContain("last ignored");
    expect(opts.originals.size).toBe(0);
  });

  test("gives every static survivor to the tests, however long they take", async () => {
    // The tests are the only thing that can answer for a mutant that cleared
    // the gates, so none may be skipped over on account of elapsed time.
    const opts = options();
    const tested: string[] = [];
    const deps = dependencies({
      evaluateStatic: () =>
        Promise.resolve(
          mutants.map((mutant) => staticResult(mutant, "survived", 10_000)),
        ),
      evaluateTests: (_plan, mutant) => {
        tested.push(mutant.anchor);
        return Promise.resolve({
          detectedBy: null,
          status: "survived",
          timings: [],
        });
      },
    });

    await runFileMutants(plan, opts, context(), deps);

    expect(tested).toEqual(mutants.map((mutant) => mutant.anchor));
    expect(opts.results.map(({ status }) => status)).toEqual(
      mutants.map(() => "survived"),
    );
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
