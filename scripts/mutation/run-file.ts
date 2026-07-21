import { dim, green, red, yellow } from "#scripts/precommit/colors.ts";
import { write } from "#scripts/precommit/write.ts";
import { evaluateMutant, type FileMutationPlan } from "./evaluate.ts";
import { type StaticGate, type TestRunConfig, testEnv } from "./execution.ts";
import { type IgnoreList, isIgnored } from "./ignore.ts";
import {
  formatProgressLine,
  type MutantResult,
  type Status,
} from "./summary.ts";

const PROGRESS_INTERVAL = 10;

export interface FileRunOptions {
  abortSignal: AbortSignal;
  batchJobs: number;
  ignoreList: IgnoreList;
  integrationTestFiles: string[];
  isAborted(): boolean;
  originals: Map<string, string>;
  results: MutantResult[];
  testFiles: string[];
}

export interface MutantLoopContext {
  counts: Record<Status, number>;
  gates: StaticGate[];
  perMutantTimeout: number;
  totalMutants: number;
}

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
): Promise<void> => {
  const { counts, gates, perMutantTimeout, totalMutants } = ctx;
  const run: TestRunConfig = {
    batchJobs: opts.batchJobs,
    env: testEnv(),
    testFiles: opts.testFiles,
  };
  for (const mutant of plan.mutants) {
    if (opts.isAborted()) break;
    opts.originals.set(plan.file, plan.original);
    const signal = AbortSignal.any([
      opts.abortSignal,
      AbortSignal.timeout(perMutantTimeout),
    ]);
    const evaluation = await evaluateMutant(
      plan,
      mutant,
      run,
      opts.integrationTestFiles,
      gates,
      signal,
    );
    opts.originals.delete(plan.file);
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
