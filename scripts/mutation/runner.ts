/**
 * Mutation test runner.
 *
 * Static gates run concurrently in isolated copies. Mutants that pass them are
 * then written over the copied run's source one at a time for tests and restored
 * afterwards. In-place test mutation is what makes this project's `#…`
 * import-map aliases bind to the mutant.
 *
 * A mutant is "killed" when a static gate rejects it or the tests fail, and
 * "survived" when it clears every gate and the tests still pass (a gap in the
 * tests). There is no third answer: every mutant is decided by what a gate or a
 * test actually said, never by how long it took to say it.
 */

import { dim, red, yellow } from "#scripts/precommit/colors.ts";
import { write } from "#scripts/precommit/write.ts";
import { projectRoot, rel } from "#scripts/project-root.ts";
import type { StaticAssetBuild } from "#scripts/static-assets/session.ts";
import {
  offTerminationSignals,
  onTerminationSignals,
} from "#scripts/termination-signals.ts";
import { withTestHarness } from "#scripts/test-harness.ts";
import { TEST_STATE_DIR_ENV } from "#test/test-utils/test-state-env.ts";
import { createFilePlan, type FileMutationPlan } from "./evaluate.ts";
import {
  createStaticGates,
  runTests,
  type StaticGate,
  testEnv,
} from "./execution.ts";
import { generateMutants } from "./generate.ts";
import { ignoreListProblems, loadIgnoreList, mutantKey } from "./ignore.ts";
import { type FileRunOptions, runFileMutants } from "./run-file.ts";
import { collectModuleGraphFiles, STATE_BUILDER_ROOT } from "./state-graph.ts";
import { defaultStaticJobs, staticWorkerParent } from "./static.ts";
import {
  deadlineReport,
  formatSummaryLines,
  type MutantResult,
  type Status,
  summarize,
  writeStepSummary,
} from "./summary.ts";
import {
  buildMutationTestMap,
  type MutationTestMap,
  requireDirectMutationTests,
} from "./test-map.ts";

/** The files and knobs that describe what to mutate and how — shared by the
 * public {@link MutationOptions} and the internal {@link RunMutantsOptions} so
 * the common fields are stated once. */
interface MutationTargets {
  deadline: number;
  exhaustive: boolean;
  sourceFiles: string[];
  testFiles: string[];
  useHarness: boolean;
}

export interface MutationOptions extends MutationTargets {
  batchJobs?: number;
}

const BASELINE_TIMEOUT = 120_000;

const parsePositiveInt = (value: string | undefined): number | null => {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

const hardwareConcurrency = (): number => navigator.hardwareConcurrency || 1;

const defaultBatchJobs = (): number =>
  parsePositiveInt(Deno.env.get("MUTATION_JOBS")) ??
  Math.max(1, Math.min(4, hardwareConcurrency() - 1));

/**
 * Print the report (and the CI step summary), returning the exit code:
 * 0 = every mutant detected (or all survivors are known-equivalent), 1 =
 * survivors, 2 = inconclusive (no mutants at all, so the run proved nothing —
 * fail rather than report a vacuous 100%). A file whose every mutant is
 * suppressed is *not* inconclusive: that is what the ignore-list is for, so it
 * passes.
 */
const report = (results: MutantResult[]): number => {
  const summary = summarize(results);
  for (const line of formatSummaryLines(summary)) console.log(line);
  writeStepSummary(summary);
  if (summary.total === 0) return 2;
  return summary.survived === 0 ? 0 : 1;
};

interface RunMutantsOptions extends MutationTargets, FileRunOptions {
  hitDeadline(): boolean;
  restoreAll: () => void;
  staticAssets: StaticAssetBuild | null;
  testMap: MutationTestMap;
}

/**
 * Run the baseline (unmutated) tests. Returns `{ code }` when the run should
 * stop early (interrupted, or a non-green baseline), or `null` when the
 * baseline passed and mutation can proceed.
 */
const establishBaseline = async (
  opts: RunMutantsOptions,
): Promise<{ code: number } | null> => {
  const { abortSignal, batchJobs, isAborted, testFiles } = opts;
  console.log(dim("Running baseline (unmutated) tests…"));
  // The baseline runs unmutated code, so the prebuilt state snapshot is valid
  // for it even when some target feeds that state.
  const baseline = await runTests(
    { batchJobs, env: testEnv(), testFiles },
    AbortSignal.any([abortSignal, AbortSignal.timeout(BASELINE_TIMEOUT)]),
  );
  if (isAborted()) return { code: 130 };
  if (baseline.outcome !== "passed") {
    console.error(red(`\nBaseline tests did not pass (${baseline.outcome}).`));
    console.error(
      "Mutation testing needs a green baseline. Fix the tests, or add --harness",
    );
    console.error(
      "if these tests import the app / Stripe and need stripe-mock + built assets.",
    );
    return { code: 1 };
  }
  console.log(
    dim(`Baseline passed in ${Math.round(baseline.durationMs)}ms.\n`),
  );
  console.log(dim(`Using up to ${batchJobs} concurrent test batch(es).`));
  return null;
};

/**
 * Probe that the *unmutated* target passes every static gate before its mutants
 * run, and report loudly if not. A gate can only tell a mutation-introduced
 * diagnostic apart from a broken tool or an already-dirty target if the
 * unmutated file passes it. The file on disk is the original here (restored
 * after every mutant), so probe it once per file per gate — the type-check
 * probe also warms the module cache, so the file's per-mutant `deno check`s
 * re-type only the one changed file. A non-zero exit means that gate can't be
 * trusted — precommit typechecks and runs `lint:ci` before mutation, but a
 * standalone `deno task mutation` does not — so the caller aborts rather than
 * record every mutant as a bogus static kill. Probing the target itself (not a
 * fixed path) also means a run that mutates this very file never reprobes a
 * path that is currently holding a mutant.
 */
const isUnmutatedTargetDirty = async (
  plan: FileMutationPlan,
  gates: StaticGate[],
  signal: AbortSignal,
): Promise<boolean> => {
  if (plan.mutants.length === 0) return false;
  for (const gate of gates) {
    if ((await gate.exit(plan.file, projectRoot, signal)) === 0) continue;
    console.error(
      red(
        `\nThe unmutated ${rel(plan.file)} does not pass the ${gate.label} gate.`,
      ),
    );
    for (const line of gate.remedy) console.error(line);
    return true;
  }
  return false;
};

/**
 * Re-check the ignore-list against the run's results and report any stale
 * entries, returning the final exit code. The ignore-list is location-based, so
 * it drifts as code moves. Re-check it here — only for the files just mutated —
 * and fail if any entry no longer lines up with a real survivor, so it gets
 * fixed instead of rotting. Staleness is checked against every mutant
 * --exhaustive could produce (regardless of the mode this run used), so an
 * entry for an exhaustive-only replacement isn't falsely flagged during a
 * non-exhaustive (e.g. precommit) run.
 */
const reportIgnoreListStaleness = (
  opts: RunMutantsOptions,
  plans: FileMutationPlan[],
  exitCode: number,
): number => {
  const possibleKeys = new Set(
    plans.flatMap((plan) =>
      generateMutants(plan.original, plan.file, true).map((mutant) =>
        mutantKey(plan.file, mutant),
      ),
    ),
  );
  const problems = ignoreListProblems(
    opts.ignoreList,
    opts.results,
    opts.sourceFiles,
    possibleKeys,
  );
  if (problems.length === 0) return exitCode;
  console.error(
    yellow("\nIgnore-list issues (scripts/mutation/equivalent-mutants/):"),
  );
  for (const problem of problems) console.error(red(`  ✗ ${problem}`));
  console.error(
    dim("  Update or remove these so the list stays in sync with reality."),
  );
  return exitCode === 0 ? 1 : exitCode;
};

/**
 * The exit code for a run that stopped before answering every mutant, or null
 * when it ran to the end and a score can be published.
 */
const unfinishedRunExit = (
  opts: RunMutantsOptions,
  tested: number,
  plans: readonly FileMutationPlan[],
): number | null => {
  if (opts.hitDeadline()) {
    const total = plans.reduce((sum, plan) => sum + plan.mutants.length, 0);
    for (const line of deadlineReport(opts.deadline, tested, total)) {
      console.error(line);
    }
    return 1;
  }
  if (opts.isAborted()) {
    console.log(yellow("Interrupted — restored sources and built assets."));
    return 130;
  }
  return null;
};

/** Baseline check, then the per-file/per-mutant loop, then the report. */
const runMutants = async (opts: RunMutantsOptions): Promise<number> => {
  const {
    exhaustive,
    isAborted,
    restoreAll,
    results,
    staticAssets,
    useHarness,
  } = opts;

  // Under --harness the client bundles are built once; a mutant on a bundled
  // source must rebuild the affected bundle(s) or it would falsely survive.
  const rebuilder = useHarness ? staticAssets : null;
  if (useHarness && rebuilder === null) {
    throw new Error("Harness mutation run is missing its static asset build.");
  }
  // Likewise the run-wide test state was built before any mutant existed: a
  // mutant in a file that state was built from must not let its tests seed
  // from the stale snapshot, so those files run without the state env var.
  const stateBuilderFiles = Deno.env.get(TEST_STATE_DIR_ENV)
    ? await collectModuleGraphFiles(STATE_BUILDER_ROOT, projectRoot)
    : null;
  const plans: FileMutationPlan[] = [];
  for (const target of opts.testMap.targets) {
    const plan = await createFilePlan(
      rebuilder,
      stateBuilderFiles,
      exhaustive,
      target.sourceFile,
      target.directTestFiles,
    );
    requireDirectMutationTests(
      plan.file,
      plan.mutants.length,
      plan.directTestFiles,
    );
    plans.push(plan);
  }

  const baseline = await establishBaseline(opts);
  if (baseline !== null) return baseline.code;
  const gates = await createStaticGates();
  console.log(
    dim(`Using up to ${opts.staticJobs} concurrent static gate job(s).`),
  );

  try {
    const totalMutants = plans.reduce(
      (sum, plan) => sum + plan.mutants.length,
      0,
    );
    const counts: Record<Status, number> = {
      ignored: 0,
      killed: 0,
      survived: 0,
    };

    for (const plan of plans) {
      if (isAborted()) break;
      const gateSignal = AbortSignal.any([
        opts.abortSignal,
        AbortSignal.timeout(BASELINE_TIMEOUT),
      ]);
      if (await isUnmutatedTargetDirty(plan, gates, gateSignal)) return 1;
      await runFileMutants(plan, opts, { counts, gates, totalMutants });
    }
  } finally {
    restoreAll();
  }
  write("\n");

  const early = unfinishedRunExit(opts, results.length, plans);
  if (early !== null) return early;

  return reportIgnoreListStaleness(opts, plans, report(results));
};

const mutate = async (
  options: MutationOptions,
  staticAssets: StaticAssetBuild | null,
  testMap: MutationTestMap,
): Promise<number> => {
  const { deadline, exhaustive, sourceFiles, testFiles } = options;
  const batchJobs = options.batchJobs ?? defaultBatchJobs();
  const ignoreList = await loadIgnoreList();
  const results: MutantResult[] = [];
  const originals = new Map<string, string>();
  const restoreAll = (): void => {
    for (const [file, content] of originals) {
      Deno.writeTextFileSync(file, content);
    }
  };
  // On SIGINT/SIGTERM, abort the in-flight test run and let the loop fall
  // through so every `finally` runs: the source and built assets are restored
  // here, then the outer withTestHarness stops stripe-mock and removes any
  // generated assets. Going straight to Deno.exit would skip all of that. A
  // second signal force-quits in case unwinding ever stalls. Listeners are
  // installed before the baseline so an interrupt there also unwinds cleanly;
  // a signal during the earlier withTestHarness *setup* still takes Deno's
  // default exit (see runMutationTesting).
  const abortController = new AbortController();
  let aborted = false;
  let hitDeadline = false;
  const onSignal = (): void => {
    if (aborted) {
      restoreAll();
      Deno.exit(130);
    }
    aborted = true;
    abortController.abort();
  };
  onTerminationSignals(onSignal);
  // The only clock left in the run, and it never judges a mutant: it exists so
  // a mutant that hangs the tests cannot wedge the run forever. When it fires
  // the whole run fails and reports nothing, rather than scoring anything.
  const deadlineTimer = setTimeout(() => {
    hitDeadline = true;
    aborted = true;
    abortController.abort();
  }, deadline);

  try {
    return await runMutants({
      abortSignal: abortController.signal,
      batchJobs,
      deadline,
      exhaustive,
      hitDeadline: () => hitDeadline,
      ignoreList,
      integrationTestFiles: testMap.integrationTestFiles,
      isAborted: () => aborted,
      originals,
      restoreAll,
      results,
      sourceFiles,
      staticAssets,
      staticJobs: defaultStaticJobs(),
      staticWorkerParent: staticWorkerParent(),
      testFiles,
      testMap,
      useHarness: options.useHarness,
    });
  } finally {
    clearTimeout(deadlineTimer);
    offTerminationSignals(onSignal);
  }
};

/**
 * Entry point: run mutation testing, returning a process exit code.
 *
 * Known limitation: under --harness, a SIGINT/SIGTERM that lands during
 * withTestHarness's *setup* (preparing static assets, starting stripe-mock) —
 * before mutate() installs its handlers — takes Deno's default exit, so a
 * freshly started stripe-mock can be left behind. It self-heals on the next run
 * (the harness reuses an existing mock), and this brief window is shared by the
 * regular test runners. Built assets are deliberately kept either way — they
 * are what lets the next run skip the build — and a run killed mid-build simply
 * leaves no record, so the next run rebuilds. Signals during the baseline and
 * mutation phases are handled gracefully by mutate().
 */
export const runMutationTesting = async (
  options: MutationOptions,
): Promise<number> => {
  const testMap = buildMutationTestMap(options.sourceFiles, options.testFiles);
  for (const target of testMap.targets) {
    if (target.directTestFiles.length > 0) continue;
    const source = await Deno.readTextFile(target.sourceFile);
    requireDirectMutationTests(
      target.sourceFile,
      generateMutants(source, target.sourceFile, options.exhaustive).length,
      target.directTestFiles,
    );
  }
  return options.useHarness
    ? withTestHarness(({ staticAssets }) =>
        mutate(options, staticAssets, testMap),
      )
    : mutate(options, null, testMap);
};
