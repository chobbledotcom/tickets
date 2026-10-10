import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { ResolvedEntry } from "#scripts/mutation/equivalent-audit.ts";
import {
  type ReproveDeps,
  reproveEntries,
} from "#scripts/mutation/equivalent-reproof.ts";
import type {
  FileMutationPlan,
  MutantEvaluation,
} from "#scripts/mutation/evaluate.ts";
import type { Mutant } from "#scripts/mutation/generate.ts";

const mutant: Mutant = {
  anchor: "read~0abc123",
  column: 5,
  end: 12,
  line: 1,
  newOperator: "||",
  operator: "??",
  start: 8,
};

const entryAt = (
  file: string,
  registry: number,
  index: number,
): ResolvedEntry => ({
  ...mutant,
  chunk: "src/read.ts::read~0abc123 ?? → ||  audited:041pxgm   # why\n",
  file,
  index,
  key: "src/read.ts::read~0abc123 ??→||",
  line: "src/read.ts::read~0abc123 ?? → ||  audited:041pxgm   # why",
  mutant,
  original: "export const read = (x: string | undefined) => x ?? 0;\n",
  reason: "why",
  registry,
  sourcePath: "src/read.ts",
  stamp: "audited:041pxgm",
});

const planFor = (
  file: string,
  directTestFiles: string[],
): FileMutationPlan => ({
  assets: null,
  directTestFiles,
  file,
  mutants: [mutant],
  original: "original",
  rebuildTestState: false,
});

const evaluation = (status: MutantEvaluation["status"]): MutantEvaluation => ({
  detectedBy: status === "killed" ? "direct-tests" : null,
  status,
  timings: [],
});

/** The direct-test mapping the sweep reads: one entry per file, decided by
 * the case. Every file maps to something unless the case says otherwise. */
const directTestsFor =
  (testsFor: (file: string) => string[]) =>
  (files: string[]): Promise<Map<string, string[]>> =>
    Promise.resolve(new Map(files.map((file) => [file, testsFor(file)])));

/** Deps that map every file to one direct test and let each case decide what
 * the test run says. */
const deps = (
  evaluate: (file: string) => Promise<MutantEvaluation>,
  changes: Partial<ReproveDeps> = {},
): ReproveDeps => ({
  batchJobs: 3,
  createPlan: (file, directTestFiles) =>
    Promise.resolve(planFor(file, directTestFiles)),
  directTestFiles: directTestsFor((file) => [`test/${file}.test.ts`]),
  env: { STRIPE_MOCK_PORT: "12111" },
  evaluate: (plan, _mutant, run, signal) => {
    if (run.env.STRIPE_MOCK_PORT !== "12111") {
      throw new Error("the harness env must reach the test run");
    }
    if (run.batchJobs !== 3) throw new Error("batch jobs must pass through");
    void signal;
    return evaluate(plan.file);
  },
  ...changes,
});

describe("the audit's distinguishing-input phase", () => {
  test("drops an entry a test kills and keeps the chunk id with the line", async () => {
    const first = entryAt("/work/a.ts", 0, 3);
    const outcome = await reproveEntries(
      [first],
      deps(() => Promise.resolve(evaluation("killed"))),
      new AbortController().signal,
    );

    expect(outcome.killedLines).toEqual([first.line]);
    expect(outcome.killedChunks).toEqual(new Set(["0:3"]));
    expect(outcome.untested).toEqual([]);
  });

  test("keeps an entry the direct tests do not distinguish", async () => {
    const outcome = await reproveEntries(
      [entryAt("/work/a.ts", 0, 0)],
      deps(() => Promise.resolve(evaluation("survived"))),
      new AbortController().signal,
    );

    expect(outcome.killedLines).toEqual([]);
    expect(outcome.killedChunks).toEqual(new Set());
    expect(outcome.untested).toEqual([]);
  });

  test("runs each entry's mutant against that file's own direct tests", async () => {
    const runs: string[] = [];
    const first = entryAt("/work/a.ts", 0, 0);
    const second = entryAt("/work/b.ts", 0, 5);
    await reproveEntries(
      [first, second],
      deps((file) => {
        runs.push(file);
        return Promise.resolve(evaluation("survived"));
      }),
      new AbortController().signal,
    );

    expect(runs).toEqual(["/work/a.ts", "/work/b.ts"]);
  });

  test("skips an entry whose source has no direct test to distinguish with", async () => {
    const tested = entryAt("/work/a.ts", 1, 2);
    const untested = entryAt("/work/b.ts", 0, 7);
    const outcome = await reproveEntries(
      [tested, untested],
      deps(() => Promise.resolve(evaluation("survived")), {
        // The map names only files the sweep can distinguish with: a file
        // absent from it has no direct test at all.
        directTestFiles: (files) =>
          Promise.resolve(
            new Map(
              files
                .filter((file) => file === tested.file)
                .map((file) => [file, ["test/a.test.ts"]]),
            ),
          ),
      }),
      new AbortController().signal,
    );

    expect(outcome.untested).toEqual([untested.line]);
    expect(outcome.killedLines).toEqual([]);
  });

  test("creates one plan per file with that file's direct tests", async () => {
    const plans: [string, string[]][] = [];
    const outcome = await reproveEntries(
      [entryAt("/work/a.ts", 0, 0), entryAt("/work/a.ts", 0, 1)],
      deps(() => Promise.resolve(evaluation("survived")), {
        createPlan: (file, directTestFiles) => {
          plans.push([file, directTestFiles]);
          return Promise.resolve(planFor(file, directTestFiles));
        },
      }),
      new AbortController().signal,
    );

    expect(plans).toEqual([["/work/a.ts", ["test//work/a.ts.test.ts"]]]);
    expect(outcome.killedLines).toEqual([]);
  });

  test("stops at an aborted signal instead of running more entries", async () => {
    const controller = new AbortController();
    const first = entryAt("/work/a.ts", 0, 0);
    const second = entryAt("/work/b.ts", 0, 1);
    let runs = 0;

    await expect(
      reproveEntries(
        [first, second],
        deps(() => {
          runs += 1;
          controller.abort();
          return Promise.resolve(evaluation("survived"));
        }),
        controller.signal,
      ),
    ).rejects.toThrow(/abort/i);

    expect(runs).toBe(1);
  });
});
