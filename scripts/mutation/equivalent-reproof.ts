/**
 * The audit's distinguishing-input phase.
 *
 * A recorded entry claims no possible input distinguishes the mutant from the
 * original. The existing tests are the inputs anyone can try without writing
 * new ones, so this phase runs each confirmed, gate-surviving entry's mutant
 * against its file's mapped direct tests — the same direct stage a mutation
 * run uses, asset rebuilds and test-state handling included — and reports the
 * entries a test kills. A killed mutant is not equivalent: the entry drops,
 * and the mutation gate then demands the test that killed it.
 *
 * A survivor keeps its entry. This phase never proves equivalence — it can
 * only disprove it — so an entry the direct tests leave standing is still
 * exactly as proved as it was, by the reason a person wrote beside it.
 */

import { rel } from "#scripts/project-root.ts";
import type { ReproveOutcome, ResolvedEntry } from "./equivalent-audit.ts";
import type { FileMutationPlan, MutantEvaluation } from "./evaluate.ts";
import type { TestRunConfig } from "./execution.ts";
import type { Mutant } from "./generate.ts";

export interface ReproveDeps {
  /** Concurrent test batches per entry, sized the way the runner sizes them. */
  batchJobs: number;
  /** One plan per file, carrying the runner's asset and state handling. */
  createPlan(
    file: string,
    directTestFiles: string[],
  ): Promise<FileMutationPlan>;
  /** Each file's direct tests — the only tests this phase runs. A file with
   * none has no distinguishing input to attempt, and its entries stand. */
  directTestFiles(files: string[]): Promise<Map<string, string[]>>;
  /** The harness environment the child test processes inherit. */
  env: Record<string, string>;
  /** The runner's own mutant evaluation, direct tests only. */
  evaluate(
    plan: FileMutationPlan,
    mutant: Mutant,
    run: TestRunConfig,
    signal: AbortSignal,
  ): Promise<MutantEvaluation>;
  /** The original text's direct-test run, taken once per file before its
   * mutants: a suite that already fails distinguishes nothing. */
  evaluateBaseline(
    plan: FileMutationPlan,
    run: TestRunConfig,
    signal: AbortSignal,
  ): Promise<MutantEvaluation>;
}

/** The test-run configuration one file's direct stage uses. */
const runConfigFor = (
  plan: FileMutationPlan,
  deps: ReproveDeps,
): TestRunConfig => ({
  batchJobs: deps.batchJobs,
  env: deps.env,
  testFiles: plan.directTestFiles,
});

/** The file's original-text run, taken once per file. A suite that already
 * fails distinguishes nothing, so a red baseline stops the sweep: pruning on
 * it would record a kill the mutant did not cause. */
const baselineFor = async (
  plan: FileMutationPlan,
  baselines: Map<string, MutantEvaluation>,
  deps: ReproveDeps,
  signal: AbortSignal,
): Promise<MutantEvaluation> => {
  const known = baselines.get(plan.file);
  if (known) return known;
  const baseline = await deps.evaluateBaseline(
    plan,
    runConfigFor(plan, deps),
    signal,
  );
  baselines.set(plan.file, baseline);
  if (baseline.status === "cancelled") signal.throwIfAborted();
  if (baseline.status !== "survived") {
    throw new Error(
      `Unmutated ${rel(plan.file)} does not pass its direct tests, so they cannot distinguish anything.`,
    );
  }
  return baseline;
};

/**
 * Run the distinguishing attempt for every entry, in the order the registry
 * lists them. Only a kill changes anything: the outcome names the entries to
 * prune, and everything else stands exactly as it stood.
 */
export const reproveEntries = async (
  entries: ResolvedEntry[],
  deps: ReproveDeps,
  signal: AbortSignal,
): Promise<ReproveOutcome> => {
  const files = [...new Set(entries.map((entry) => entry.file))];
  const direct = await deps.directTestFiles(files);
  const plans = new Map<string, FileMutationPlan>();
  for (const file of files) {
    const testFiles = direct.get(file) ?? [];
    if (testFiles.length === 0) continue;
    plans.set(file, await deps.createPlan(file, testFiles));
  }

  const outcome: ReproveOutcome = {
    killedChunks: new Set(),
    killedLines: [],
    untested: [],
  };
  const baselines = new Map<string, MutantEvaluation>();
  for (const entry of entries) {
    signal.throwIfAborted();
    const plan = plans.get(entry.file);
    if (!plan) {
      outcome.untested.push(entry.line);
      continue;
    }
    await baselineFor(plan, baselines, deps, signal);
    const evaluation = await deps.evaluate(
      plan,
      entry.mutant,
      runConfigFor(plan, deps),
      signal,
    );
    if (evaluation.status !== "killed") continue;
    outcome.killedChunks.add(`${entry.registry}:${entry.index}`);
    outcome.killedLines.push(entry.line);
  }
  // An abort that lands on the last entry must not read as a clean run: the
  // caller prunes on this outcome, and a partial prune survives the copy-back.
  signal.throwIfAborted();
  return outcome;
};
