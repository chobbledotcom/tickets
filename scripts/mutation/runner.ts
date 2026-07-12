/**
 * Mutation test runner.
 *
 * For each mutant we write the mutated source over the real file, run the
 * mapped test files in a fresh `deno test` subprocess, then restore the
 * original. Mutating in place (rather than in a temp copy) is what makes
 * mutations bind through this project's `#…` import-map aliases — a fresh
 * subprocess recompiles the changed file, so the tests run against the mutant.
 *
 * Before the tests, each mutant runs through cheap static gates — a Biome lint
 * and a `deno check` type-check — that kill it outright if the mutation
 * produces forbidden code or a type error (either would fail the build, so the
 * mutant could never ship). Static checks are much faster than a full test run,
 * so ruling a mutant out this way skips the tests entirely; see createStaticGates.
 *
 * A mutant is "killed" when a static gate rejects it or the tests fail,
 * "survived" when it clears every gate and the tests still pass (a gap in the
 * tests), or "timed-out" when the mutation caused a hang (which counts as
 * detected).
 */

import { dim, green, red, yellow } from "../precommit/colors.ts";
import { write } from "../precommit/write.ts";
import { projectRoot } from "../project-root.ts";
import { stripeMockEnv } from "../stripe-mock.ts";
import { withTestHarness } from "../test-harness.ts";
import { type AssetRebuilder, createAssetRebuilder } from "./assets.ts";
import { batchTestFiles } from "./batch.ts";
import {
  denoExitCode,
  offTerminationSignals,
  onTerminationSignals,
} from "./child-process.ts";
import { applyMutant, generateMutants, type Mutant } from "./generate.ts";
import {
  type IgnoreList,
  ignoreListProblems,
  isIgnored,
  loadIgnoreList,
  mutantKey,
} from "./ignore.ts";
import {
  formatProgressLine,
  formatSummaryLines,
  type MutantResult,
  rel,
  type Status,
  summarize,
  writeStepSummary,
} from "./summary.ts";

/** The files and knobs that describe what to mutate and how — shared by the
 * public {@link MutationOptions} and the internal {@link RunMutantsOptions} so
 * the common fields are stated once. */
interface MutationTargets {
  exhaustive: boolean;
  sourceFiles: string[];
  testFiles: string[];
  timeout: number;
  useHarness: boolean;
}

export interface MutationOptions extends MutationTargets {
  batchJobs?: number;
}

type Outcome = "failed" | "passed" | "timed-out";

const BASELINE_TIMEOUT = 120_000;
const TIMEOUT_MULTIPLIER = 3;
const PROGRESS_INTERVAL = 10;

const parsePositiveInt = (value: string | undefined): number | null => {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

const hardwareConcurrency = (): number => navigator.hardwareConcurrency || 1;

const defaultBatchJobs = (): number =>
  parsePositiveInt(Deno.env.get("MUTATION_JOBS")) ??
  Math.max(1, Math.min(4, hardwareConcurrency() - 1));

const testEnv = (): Record<string, string> => ({
  ...Deno.env.toObject(),
  ...stripeMockEnv(),
});

/**
 * Resolve how to invoke Biome's linter — the native binary when it is on PATH
 * (matches the Nix dev shell), otherwise the npm package (hosted CI). Mirrors
 * scripts/biome.ts so the mutation gate lints exactly as `deno task lint` does.
 */
const resolveBiome = async (): Promise<{ bin: string; pre: string[] }> => {
  try {
    const which = await new Deno.Command("which", { args: ["biome"] }).output();
    if (which.success) return { bin: "biome", pre: [] };
  } catch {
    // fall through to the npm package
  }
  return { bin: Deno.execPath(), pre: ["run", "-A", "npm:@biomejs/biome"] };
};

/**
 * A cheap static check run over a mutated file *before* the tests. Its `exit`
 * is the check's exit code (0 = clean) for the file's current on-disk contents.
 *
 * A non-zero exit is read as "the mutation introduced a diagnostic" — the
 * mutant produces code the project forbids or that would not build, so it could
 * never pass review, and we count it as detected (killed) without spending a
 * full test run on it (see evaluateMutant). Static gates are ordered cheapest
 * first, so a `deno test` is reached only for mutants that survive every one.
 *
 * That reading is only sound once the runner has confirmed, per file, that the
 * *unmutated* target passes the gate (see the baseline probe in runMutants):
 * otherwise a broken tool or a pre-existing failure in the target would fail
 * every mutant and report a bogus 100%. `label` names the gate in that probe's
 * message and `remedy` tells the operator how to make the target clean again.
 */
interface StaticGate {
  /** The gate's exit code for the file's current on-disk contents (0 = clean). */
  exit(file: string): Promise<number>;
  /** Short name shown in the baseline-probe failure message (e.g. "lint"). */
  label: string;
  /** Advice printed when the *unmutated* target fails this gate. */
  remedy: string[];
}

/**
 * Biome lint gate. A passing mutant must never *mask* a genuine survivor, so:
 *   - error-severity only (plain `biome lint`, never `--error-on-warnings`):
 *     the `noExcessiveCognitiveComplexity` *warning* can trip when an
 *     `&&`/`||`/`??` swap changes a borderline function's operator mix, and
 *     killing on that would hide a real logical survivor.
 *   - lint, never `check`: a mutation that merely lengthens a line past the
 *     formatter's width is a formatting diff, not a real detection.
 * The rule this reliably catches is `noDoubleEquals` — every `=== → ==` and
 * `!== → !=` mutant produces forbidden `==`/`!=` and dies here without a test.
 */
const createLinter = async (): Promise<StaticGate> => {
  const { bin, pre } = await resolveBiome();
  return {
    exit: async (file: string): Promise<number> => {
      const { code } = await new Deno.Command(bin, {
        // --no-errors-on-unmatched: a source deliberately outside Biome's
        // includes (e.g. src/ui/client/scanner.js) is still a mutation target
        // via src/**/*.js, and linting an excluded path exits non-zero for
        // "no files processed". Silencing that makes such a file lint clean
        // (exit 0) so its mutants fall through to the test/build path instead
        // of the baseline probe mistaking it for a dirty target and aborting.
        args: [...pre, "lint", "--no-errors-on-unmatched", file],
        cwd: projectRoot,
        stderr: "null",
        stdout: "null",
      }).output();
      return code;
    },
    label: "lint",
    remedy: [
      "The mutation lint gate needs a lint-clean target and a working Biome.",
      "Run `deno task lint` and fix any errors (precommit runs lint:ci first;",
      "a standalone `deno task mutation` does not), then retry.",
    ],
  };
};

/**
 * TypeScript type-check gate. `deno check <file>` type-checks the mutated file
 * and its import graph; a non-zero exit means the mutation introduced a type
 * error. The project must type-check to build, so such a mutant could never
 * ship — count it as detected without running the tests. Type-checking is far
 * cheaper than a full `deno test` (the baseline probe warms the module cache by
 * checking the unmutated file first, so per-mutant checks re-type only the one
 * changed file), which is exactly why it runs before the tests.
 *
 * Unlike the lint gate there is no warning/formatting nuance to guard against:
 * `deno check` reports type errors only, and *every* type error is a build
 * failure, so killing on one can never mask a survivor the tests should catch.
 * A `.js` mutation target (client-bundle source) type-checks clean and simply
 * falls through to the test path.
 */
const createTypeChecker = (): StaticGate => ({
  exit: (file: string): Promise<number> =>
    denoExitCode(["check", file], {
      cwd: projectRoot,
      stderr: "null",
      stdout: "null",
    }),
  label: "type-check",
  remedy: [
    "The mutation type-check gate needs a type-clean target and a working deno.",
    "Run `deno task typecheck` and fix any errors (precommit typechecks first;",
    "a standalone `deno task mutation` does not), then retry.",
  ],
});

/**
 * The static gates run over each mutant before the tests, cheapest first: the
 * per-file Biome lint (no module graph), then the `deno check` type-check
 * (graph, but cache-warmed). A mutant reaches `deno test` only if it survives
 * both.
 */
const createStaticGates = async (): Promise<StaticGate[]> => [
  await createLinter(),
  createTypeChecker(),
];

/** Run one `deno test` process over `batch`, returning its exit code. */
const runTestBatch = (batch: string[], signal: AbortSignal): Promise<number> =>
  denoExitCode(
    [
      "test",
      "--no-check",
      "--allow-all",
      "--parallel",
      // Load the fast `toContain` override in every isolate — the barrel that
      // used to pull it into each test file's graph is gone, so without this
      // mutation batches fall back to the slow matcher. See test-harness.ts.
      "--preload",
      "./test/test-utils/fast-expect.ts",
      "--v8-flags=--expose-gc",
      ...batch,
    ],
    {
      cwd: projectRoot,
      env: testEnv(),
      signal,
      stderr: "null",
      stdout: "null",
    },
  );

/**
 * Run the test files once, returning the outcome and how long it took.
 *
 * The files are run in batches, each in its own `deno test` process, to cap how
 * many test files a single process loads at a time — see ./batch.ts for why the
 * local libsql driver's per-transaction fd leak makes a one-big-process run
 * spike past the open-file ceiling ("Too many open files"). A fresh process per
 * batch releases every fd on exit, so the peak stays bounded by one batch.
 *
 * A non-zero batch is enough to decide the run: it fails the baseline, or kills
 * a mutant, so the remaining batches are skipped. All batches share one timeout
 * and abort signal, so a mutant that hangs is still caught as "timed-out".
 */
const runTests = async (
  testFiles: string[],
  timeoutMs: number,
  batchJobs: number,
  abortSignal?: AbortSignal,
): Promise<{ durationMs: number; outcome: Outcome }> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = (): void => controller.abort();
  if (abortSignal?.aborted) controller.abort();
  else abortSignal?.addEventListener("abort", onAbort, { once: true });
  const startedAt = performance.now();
  const elapsed = (): number => performance.now() - startedAt;
  try {
    const batches = batchTestFiles(testFiles);
    let nextBatch = 0;
    const worker = async (): Promise<Outcome | null> => {
      while (!controller.signal.aborted) {
        const batch = batches[nextBatch];
        nextBatch += 1;
        if (!batch) return null;
        try {
          const code = await runTestBatch(batch, controller.signal);
          if (code !== 0) {
            controller.abort();
            return "failed";
          }
        } catch {
          return "timed-out";
        }
      }
      return null;
    };
    const jobs = Math.min(Math.max(1, batchJobs), Math.max(1, batches.length));
    const outcomes = await Promise.all(
      Array.from({ length: jobs }, () => worker()),
    );
    const outcome = outcomes.includes("failed")
      ? "failed"
      : outcomes.includes("timed-out")
        ? "timed-out"
        : "passed";
    return { durationMs: elapsed(), outcome };
  } catch {
    return { durationMs: elapsed(), outcome: "timed-out" };
  } finally {
    clearTimeout(timer);
    abortSignal?.removeEventListener("abort", onAbort);
  }
};

const toStatus = (outcome: Outcome): Status =>
  outcome === "passed"
    ? "survived"
    : outcome === "failed"
      ? "killed"
      : "timed-out";

const statusGlyph = (status: Status): string =>
  status === "killed"
    ? green(".")
    : status === "timed-out"
      ? yellow("T")
      : status === "ignored"
        ? dim("i")
        : red("S");

/**
 * Hooks for keeping a mutated source's built client bundle(s) in sync, used
 * only under `--harness` when the source feeds `src/ui/static/*.js`.
 */
interface MutantAssetHooks {
  rebuild: () => Promise<boolean>;
  restore: () => Promise<void>;
}

interface FileMutationPlan {
  assets: MutantAssetHooks | null;
  file: string;
  mutants: Mutant[];
  original: string;
}

/** Mutate the file, run the tests, and always restore the original. */
const evaluateMutant = async (
  file: string,
  original: string,
  mutant: Mutant,
  testFiles: string[],
  timeoutMs: number,
  batchJobs: number,
  assets: MutantAssetHooks | null,
  gates: StaticGate[],
  abortSignal: AbortSignal,
): Promise<Status> => {
  await Deno.writeTextFile(file, applyMutant(original, mutant));
  try {
    // A mutant that produces code a static gate rejects — `==` under Biome's
    // noDoubleEquals, or a type error under `deno check` — is detected
    // statically, killed before we spend a full test run on it. The unmutated
    // target is verified clean per gate per file (see runMutants), so a
    // non-zero exit here is a mutation-introduced diagnostic, not a broken
    // tool. Gates run cheapest first; see createStaticGates for the rationale.
    for (const gate of gates) {
      if ((await gate.exit(file)) !== 0) return "killed";
    }
    // A mutant that breaks the client-bundle build must not be tested against a
    // stale baseline asset (the tests would pass and it would falsely survive).
    // A failed build means the mutation is detected, so count it as killed.
    if (assets && !(await assets.rebuild())) return "killed";
    const { outcome } = await runTests(
      testFiles,
      timeoutMs,
      batchJobs,
      abortSignal,
    );
    return toStatus(outcome);
  } finally {
    await Deno.writeTextFile(file, original);
    if (assets) await assets.restore();
  }
};

const logFilePlan = (plan: FileMutationPlan, affectedCount: number): void => {
  if (plan.mutants.length === 0) {
    console.log(yellow(`  no mutable operators in ${rel(plan.file)}`));
    return;
  }
  const note =
    affectedCount > 0
      ? dim(` (rebuilding ${affectedCount} bundle(s) per mutant)`)
      : "";
  console.log(
    dim(`  ${rel(plan.file)}: ${plan.mutants.length} mutants`) + note,
  );
};

const filePlan = async (
  rebuilder: AssetRebuilder | null,
  exhaustive: boolean,
  file: string,
): Promise<FileMutationPlan> => {
  const original = await Deno.readTextFile(file);
  const affected = rebuilder ? rebuilder.affected(file) : [];
  const assets: MutantAssetHooks | null =
    rebuilder && affected.length > 0
      ? {
          rebuild: () => rebuilder.rebuild(affected),
          restore: () => rebuilder.restore(affected),
        }
      : null;
  const plan = {
    assets,
    file,
    mutants: generateMutants(original, file, exhaustive),
    original,
  };
  logFilePlan(plan, affected.length);
  return plan;
};

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

interface RunMutantsOptions extends MutationTargets {
  abortSignal: AbortSignal;
  batchJobs: number;
  ignoreList: IgnoreList;
  isAborted: () => boolean;
  originals: Map<string, string>;
  restoreAll: () => void;
  results: MutantResult[];
}

/**
 * Run the baseline (unmutated) tests. Returns `{ code }` when the run should
 * stop early (interrupted, or a non-green baseline), or the derived
 * `{ perMutantTimeout }` when the baseline passed and mutation can proceed.
 */
const establishBaseline = async (
  opts: RunMutantsOptions,
): Promise<{ code: number } | { perMutantTimeout: number }> => {
  const { abortSignal, batchJobs, isAborted, testFiles, timeout } = opts;
  console.log(dim("Running baseline (unmutated) tests…"));
  const baseline = await runTests(
    testFiles,
    BASELINE_TIMEOUT,
    batchJobs,
    abortSignal,
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
  const perMutantTimeout = Math.max(
    timeout,
    Math.ceil(baseline.durationMs * TIMEOUT_MULTIPLIER),
  );
  console.log(
    dim(
      `Baseline passed in ${Math.round(baseline.durationMs)}ms; per-mutant timeout ${perMutantTimeout}ms.\n`,
    ),
  );
  console.log(dim(`Using up to ${batchJobs} concurrent test batch(es).`));
  return { perMutantTimeout };
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
): Promise<boolean> => {
  if (plan.mutants.length === 0) return false;
  for (const gate of gates) {
    if ((await gate.exit(plan.file)) === 0) continue;
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

/** Print the running progress line for a mutant, on the cadence the loop uses. */
const reportMutantProgress = (
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

interface MutantLoopContext {
  counts: Record<Status, number>;
  gates: StaticGate[];
  perMutantTimeout: number;
  totalMutants: number;
}

/** Evaluate every mutant for one file plan, recording results and progress. */
const evaluatePlanMutants = async (
  plan: FileMutationPlan,
  opts: RunMutantsOptions,
  ctx: MutantLoopContext,
): Promise<void> => {
  const { counts, gates, perMutantTimeout, totalMutants } = ctx;
  const {
    abortSignal,
    batchJobs,
    ignoreList,
    isAborted,
    originals,
    results,
    testFiles,
  } = opts;
  for (const mutant of plan.mutants) {
    if (isAborted()) break;
    originals.set(plan.file, plan.original);
    const outcome = await evaluateMutant(
      plan.file,
      plan.original,
      mutant,
      testFiles,
      perMutantTimeout,
      batchJobs,
      plan.assets,
      gates,
      abortSignal,
    );
    originals.delete(plan.file);
    if (isAborted()) break;
    // A survivor recorded as known-equivalent is suppressed, not a failure.
    const status: Status =
      outcome === "survived" && isIgnored(ignoreList, plan.file, mutant)
        ? "ignored"
        : outcome;
    const result = { file: plan.file, mutant, status };
    results.push(result);
    counts[status] += 1;
    write(statusGlyph(status));
    reportMutantProgress(result, counts, results.length, totalMutants);
  }
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
    yellow("\nIgnore-list issues (scripts/mutation/equivalent-mutants.txt):"),
  );
  for (const problem of problems) console.error(red(`  ✗ ${problem}`));
  console.error(
    dim("  Update or remove these so the list stays in sync with reality."),
  );
  return exitCode === 0 ? 1 : exitCode;
};

/** Baseline check, then the per-file/per-mutant loop, then the report. */
const runMutants = async (opts: RunMutantsOptions): Promise<number> => {
  const {
    exhaustive,
    isAborted,
    restoreAll,
    results,
    sourceFiles,
    useHarness,
  } = opts;

  const baseline = await establishBaseline(opts);
  if ("code" in baseline) return baseline.code;
  const { perMutantTimeout } = baseline;

  // Under --harness the client bundles are built once; a mutant on a bundled
  // source must rebuild the affected bundle(s) or it would falsely survive.
  const rebuilder: AssetRebuilder | null = useHarness
    ? await createAssetRebuilder()
    : null;
  const gates = await createStaticGates();

  // Hoisted out of the try block: the ignore-list staleness check after it
  // needs each plan's original source to regenerate the --exhaustive mutant
  // set, regardless of which mode this run used.
  const plans: FileMutationPlan[] = [];
  try {
    for (const file of sourceFiles) {
      plans.push(await filePlan(rebuilder, exhaustive, file));
    }
    const totalMutants = plans.reduce(
      (sum, plan) => sum + plan.mutants.length,
      0,
    );
    const counts: Record<Status, number> = {
      ignored: 0,
      killed: 0,
      survived: 0,
      "timed-out": 0,
    };

    for (const plan of plans) {
      if (isAborted()) break;
      if (await isUnmutatedTargetDirty(plan, gates)) return 1;
      await evaluatePlanMutants(plan, opts, {
        counts,
        gates,
        perMutantTimeout,
        totalMutants,
      });
    }
  } finally {
    restoreAll();
    rebuilder?.stop();
  }
  write("\n");

  if (isAborted()) {
    console.log(yellow("Interrupted — restored sources and built assets."));
    return 130;
  }

  return reportIgnoreListStaleness(opts, plans, report(results));
};

const mutate = async (options: MutationOptions): Promise<number> => {
  const { exhaustive, sourceFiles, testFiles, timeout } = options;
  const batchJobs = options.batchJobs ?? defaultBatchJobs();
  const ignoreList = await loadIgnoreList();

  const results: MutantResult[] = [];
  const originals = new Map<string, string>();
  const restoreAll = (): void => {
    for (const [file, content] of originals) {
      try {
        Deno.writeTextFileSync(file, content);
      } catch {
        // best effort; the file is git-tracked and recoverable
      }
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
  const onSignal = (): void => {
    if (aborted) {
      restoreAll();
      Deno.exit(130);
    }
    aborted = true;
    abortController.abort();
  };
  onTerminationSignals(onSignal);

  try {
    return await runMutants({
      abortSignal: abortController.signal,
      batchJobs,
      exhaustive,
      ignoreList,
      isAborted: () => aborted,
      originals,
      restoreAll,
      results,
      sourceFiles,
      testFiles,
      timeout,
      useHarness: options.useHarness,
    });
  } finally {
    offTerminationSignals(onSignal);
  }
};

/**
 * Entry point: run mutation testing, returning a process exit code.
 *
 * Known limitation: under --harness, a SIGINT/SIGTERM that lands during
 * withTestHarness's *setup* (building static assets, starting stripe-mock) —
 * before mutate() installs its handlers — takes Deno's default exit, so a
 * freshly started stripe-mock and generated `src/ui/static/*.js` can be left
 * behind. Both self-heal on the next run (the harness reuses an existing mock
 * and rebuilds/cleans generated assets), and this brief window is shared by the
 * regular test runners. Signals during the baseline and mutation phases are
 * handled gracefully by mutate().
 */
export const runMutationTesting = (
  options: MutationOptions,
): Promise<number> =>
  options.useHarness ? withTestHarness(() => mutate(options)) : mutate(options);
