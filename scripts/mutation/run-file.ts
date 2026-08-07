import { dim, green, red, yellow } from "#scripts/precommit/colors.ts";
import { write } from "#scripts/precommit/write.ts";
import { projectRoot } from "#scripts/project-root.ts";
import {
  evaluateMutantTests,
  type FileMutationPlan,
  type MutantEvaluation,
} from "./evaluate.ts";
import { type StaticGate, type TestRunConfig, testEnv } from "./execution.ts";
import { type IgnoreList, isIgnored } from "./ignore.ts";
import { evaluateStaticMutants, type StaticEvaluation } from "./static.ts";
import {
  formatProgressLine,
  type MutantResult,
  type Status,
} from "./summary.ts";

const PROGRESS_INTERVAL = 10;

interface FileRunDeps {
  evaluateStatic: typeof evaluateStaticMutants;
  evaluateTests: typeof evaluateMutantTests;
  now(): number;
  timeoutSignal(milliseconds: number): AbortSignal;
}

const realDeps: FileRunDeps = {
  evaluateStatic: evaluateStaticMutants,
  evaluateTests: evaluateMutantTests,
  now: performance.now.bind(performance),
  timeoutSignal: AbortSignal.timeout,
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

interface MutantLoopContext {
  counts: Record<Status, number>;
  gates: StaticGate[];
  perMutantTimeout: number;
  totalMutants: number;
}

const runTestsForStaticSurvivor = async (
  plan: FileMutationPlan,
  staticResult: StaticEvaluation,
  run: TestRunConfig,
  opts: FileRunOptions,
  deps: FileRunDeps,
): Promise<MutantEvaluation> => {
  if (staticResult.status !== "survived") return staticResult;
  const remaining = Math.max(
    0,
    Math.ceil(staticResult.deadlineAt - deps.now()),
  );
  if (remaining === 0) return { ...staticResult, status: "timed-out" };

  return withTrackedOriginal(opts, plan, () => {
    const signal = AbortSignal.any([
      opts.abortSignal,
      deps.timeoutSignal(remaining),
    ]);
    return deps.evaluateTests(
      plan,
      staticResult.mutant,
      run,
      opts.integrationTestFiles,
      signal,
      staticResult.timings,
    );
  });
};

const statusGlyph = (status: Status): string =>
  status === "killed"
    ? green(".")
    : status === "timed-out"
      ? yellow("T")
      : status === "ignored"
        ? dim("i")
        : red("S");

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
      timedOut: counts["timed-out"],
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
  const { counts, gates, perMutantTimeout, totalMutants } = ctx;
  const run: TestRunConfig = {
    batchJobs: opts.batchJobs,
    env: testEnv(),
    testFiles: opts.testFiles,
  };
  const staticResults = await withTrackedOriginal(opts, plan, () =>
    deps.evaluateStatic(plan, gates, {
      abortSignal: opts.abortSignal,
      jobs: opts.staticJobs,
      perMutantTimeout,
      root: projectRoot,
      workerParent: opts.staticWorkerParent,
    }),
  );
  for (const staticResult of staticResults) {
    if (opts.isAborted()) break;
    const { mutant } = staticResult;
    const evaluation = await runTestsForStaticSurvivor(
      plan,
      staticResult,
      run,
      opts,
      deps,
    );
    if (opts.isAborted()) break;
    const status: Status =
      evaluation.status === "survived" &&
      isIgnored(opts.ignoreList, plan.file, mutant)
        ? "ignored"
        : evaluation.status;
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
