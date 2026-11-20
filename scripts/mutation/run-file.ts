import { dim, green, red } from "#scripts/precommit/colors.ts";
import { write } from "#scripts/precommit/write.ts";
import { projectRoot } from "#scripts/project-root.ts";
import {
  evaluateMutantTests,
  type FileMutationPlan,
  type MutantEvaluation,
} from "./evaluate.ts";
import { type StaticGate, type TestRunConfig, testEnv } from "./execution.ts";
import { type IgnoreList, suppresses } from "./ignore.ts";
import { planFor, type TimedTest } from "./plan.ts";
import { evaluateStaticMutants, type StaticEvaluation } from "./static.ts";
import {
  type FrozenLoop,
  formatProgressLine,
  type MutantResult,
  type Status,
} from "./summary.ts";

const PROGRESS_INTERVAL = 10;

interface FileRunDeps {
  evaluateStatic: typeof evaluateStaticMutants;
  evaluateTests: typeof evaluateMutantTests;
}

const realDeps: FileRunDeps = {
  evaluateStatic: evaluateStaticMutants,
  evaluateTests: evaluateMutantTests,
};

const withTrackedOriginal = async <T>(
  opts: FileRunOptions,
  plan: FileMutationPlan,
  run: () => Promise<T>,
): Promise<T> => {
  opts.originals.set(plan.file, plan.original);
  try {
    return await run();
  } finally {
    opts.originals.delete(plan.file);
  }
};

export interface FileRunOptions {
  abortSignal: AbortSignal;
  batchJobs: number;
  ignoreList: IgnoreList;
  integrationTestFiles: string[];
  isAborted(): boolean;
  originals: Map<string, string>;
  results: MutantResult[];
  staticJobs: number;
  staticWorkerParent: string;
  testFiles: string[];
}

export interface MutantLoopContext {
  counts: Record<Status, number>;
  /** The first frozen test batch this run found, named by its mutant. */
  frozen: { current: FrozenLoop | null };
  gates: StaticGate[];
  /** Every test file's own baseline time: the source of each mutant's plan. */
  timings: readonly TimedTest[];
  totalMutants: number;
  /** Entries whose proof predates the file's current text: they suppress
   * nothing, so their mutants surface as the survivors they are. */
  unconfirmedKeys: Set<string>;
}

const runTestsForStaticSurvivor = async (
  plan: FileMutationPlan,
  staticResult: StaticEvaluation,
  run: TestRunConfig,
  opts: FileRunOptions,
  deps: FileRunDeps,
): Promise<MutantEvaluation> => {
  if (staticResult.status !== "survived") return staticResult;
  // The tests run to completion. Whatever they say is the mutant's verdict; a
  // clock could only ever invent one they never gave.
  return withTrackedOriginal(opts, plan, () =>
    deps.evaluateTests(
      plan,
      staticResult.mutant,
      run,
      opts.integrationTestFiles,
      opts.abortSignal,
      staticResult.timings,
    ),
  );
};

const statusGlyph = (status: Status): string =>
  status === "killed" ? green(".") : status === "ignored" ? dim("i") : red("S");

const reportProgress = (
  last: MutantResult,
  counts: Record<Status, number>,
  completed: number,
  total: number,
): void => {
  if (
    completed % PROGRESS_INTERVAL !== 0 &&
    completed !== total &&
    last.status === "killed"
  ) {
    return;
  }
  write("\n");
  console.log(
    formatProgressLine({
      completed,
      ignored: counts.ignored,
      killed: counts.killed,
      last,
      survived: counts.survived,
      total,
    }),
  );
};

export const runFileMutants = async (
  plan: FileMutationPlan,
  opts: FileRunOptions,
  ctx: MutantLoopContext,
  deps: FileRunDeps = realDeps,
): Promise<void> => {
  const { counts, gates, frozen, timings, totalMutants } = ctx;
  const run: TestRunConfig = {
    batchJobs: opts.batchJobs,
    env: testEnv(),
    limitMs: null,
    plan: (testFiles) => planFor(testFiles, timings),
    testFiles: opts.testFiles,
  };
  // A confirmed equivalent needs no gate and no test: its proof says no input
  // can tell it from the original. The audit can still disprove the entry.
  const suppressed = new Set(
    plan.mutants.filter((mutant) =>
      suppresses(opts.ignoreList, ctx.unconfirmedKeys, plan.file, mutant),
    ),
  );
  const active = plan.mutants.filter((mutant) => !suppressed.has(mutant));
  const staticResults =
    active.length === 0
      ? []
      : await withTrackedOriginal(opts, plan, () =>
          deps.evaluateStatic({ ...plan, mutants: active }, gates, {
            abortSignal: opts.abortSignal,
            jobs: opts.staticJobs,
            root: projectRoot,
            workerParent: opts.staticWorkerParent,
          }),
        );
  const staticByMutant = new Map(
    staticResults.map((result) => [result.mutant, result]),
  );
  for (const mutant of plan.mutants) {
    if (opts.isAborted()) break;
    if (suppressed.has(mutant)) {
      const result: MutantResult = {
        detectedBy: null,
        file: plan.file,
        mutant,
        status: "ignored",
        timings: [],
      };
      opts.results.push(result);
      counts.ignored += 1;
      write(statusGlyph("ignored"));
      reportProgress(result, counts, opts.results.length, totalMutants);
      continue;
    }
    const staticResult = staticByMutant.get(mutant);
    // No gate result means the run stopped before this mutant's gates finished.
    if (staticResult === undefined) break;
    const evaluation = await runTestsForStaticSurvivor(
      plan,
      staticResult,
      run,
      opts,
      deps,
    );
    if (evaluation.frozen !== undefined) {
      frozen.current = { ...evaluation.frozen, file: plan.file, mutant };
    }
    if (opts.isAborted() || evaluation.status === "cancelled") break;
    const status: Status = evaluation.status;
    const result = {
      detectedBy: evaluation.detectedBy,
      file: plan.file,
      mutant,
      status,
      timings: evaluation.timings,
    };
    opts.results.push(result);
    counts[status] += 1;
    write(statusGlyph(status));
    reportProgress(result, counts, opts.results.length, totalMutants);
  }
};
