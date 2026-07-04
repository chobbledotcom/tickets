/**
 * Mutation test runner.
 *
 * For each mutant we write the mutated source over the real file, run the
 * mapped test files in a fresh `deno test` subprocess, then restore the
 * original. Mutating in place (rather than in a temp copy) is what makes
 * mutations bind through this project's `#…` import-map aliases — a fresh
 * subprocess recompiles the changed file, so the tests run against the mutant.
 *
 * A mutant is "killed" when the tests fail, "survived" when they still pass
 * (a gap in the tests), or "timed-out" when the mutation caused a hang (which
 * counts as detected).
 */

import { dim, green, red, yellow } from "../precommit/colors.ts";
import { write } from "../precommit/write.ts";
import { projectRoot } from "../project-root.ts";
import { STRIPE_MOCK_PORT, withTestHarness } from "../test-harness.ts";
import { type AssetRebuilder, createAssetRebuilder } from "./assets.ts";
import { batchTestFiles } from "./batch.ts";
import { applyMutant, generateMutants, type Mutant } from "./generate.ts";
import {
  type IgnoreList,
  ignoreListProblems,
  isIgnored,
  loadIgnoreList,
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

export interface MutationOptions {
  batchJobs?: number;
  exhaustive: boolean;
  sourceFiles: string[];
  testFiles: string[];
  timeout: number;
  useHarness: boolean;
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
  NO_PROXY: "localhost,127.0.0.1,::1",
  no_proxy: "localhost,127.0.0.1,::1",
  STRIPE_MOCK_HOST: "localhost",
  STRIPE_MOCK_PORT: String(STRIPE_MOCK_PORT),
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
 * Lint the mutated file. The unmutated tree is lint-clean (CI enforces it), so
 * any diagnostic here was introduced by the mutation — meaning the mutant
 * produces code the project forbids and could never pass review, which we count
 * as detected (see evaluateMutant). Two deliberate restrictions stop this from
 * ever *masking* a genuine survivor:
 *   - error-severity only (plain `biome lint`, never `--error-on-warnings`):
 *     the `noExcessiveCognitiveComplexity` *warning* can trip when an
 *     `&&`/`||`/`??` swap changes a borderline function's operator mix, and
 *     killing on that would hide a real logical survivor.
 *   - lint, never `check`: a mutation that merely lengthens a line past the
 *     formatter's width is a formatting diff, not a real detection.
 * The rule this reliably catches is `noDoubleEquals` — every `=== → ==` and
 * `!== → !=` mutant produces forbidden `==`/`!=` and dies here without a test.
 */
type MutantLinter = (file: string) => Promise<boolean>;

const createLinter = async (): Promise<MutantLinter> => {
  const { bin, pre } = await resolveBiome();
  const lintExit = async (file: string): Promise<number> => {
    const { code } = await new Deno.Command(bin, {
      args: [...pre, "lint", file],
      cwd: projectRoot,
      stderr: "null",
      stdout: "null",
    }).output();
    return code;
  };

  // The gate is only trustworthy if Biome actually runs: a non-zero exit must
  // mean "found a diagnostic", never "couldn't start" (npm fallback uncached,
  // unreadable config, a crash). If a failed *invocation* were read as a
  // diagnostic, every mutant would be recorded as killed while nothing detected
  // it — a silent perfect score. The committed tree is lint-clean (CI enforces
  // it), so linting this very file is a known-good probe that must exit 0.
  // Prove it up front, and re-prove it before trusting any non-zero result
  // below; if the probe ever fails, abort loudly instead of inflating the score.
  const selfPath = import.meta.filename;
  if (!selfPath) throw new Error("mutation lint gate: no local module path");
  const brokenGate = (exit: number): Error =>
    new Error(
      `Biome lint gate is not operational: linting a known-clean file exited ${exit}. ` +
        "Fix the Biome install/config before running mutation testing.",
    );
  const probe = await lintExit(selfPath);
  if (probe !== 0) throw brokenGate(probe);

  return async (file: string): Promise<boolean> => {
    if ((await lintExit(file)) === 0) return true;
    // Non-zero: a real mutation-introduced diagnostic, or Biome broke mid-run.
    // Distinguish by re-probing the known-clean file — only reached on would-be
    // kills (rare), so the extra invocation is cheap. A clean probe confirms a
    // genuine diagnostic (killed); a failing probe means the tooling died, so
    // abort rather than record a bogus kill.
    const reprobe = await lintExit(selfPath);
    if (reprobe !== 0) throw brokenGate(reprobe);
    return false;
  };
};

/** Run one `deno test` process over `batch`, returning its exit code. */
const runTestBatch = async (
  batch: string[],
  signal: AbortSignal,
): Promise<number> => {
  const { code } = await new Deno.Command(Deno.execPath(), {
    args: [
      "test",
      "--no-check",
      "--allow-all",
      "--parallel",
      "--v8-flags=--expose-gc",
      ...batch,
    ],
    cwd: projectRoot,
    env: testEnv(),
    signal,
    stderr: "null",
    stdout: "null",
  }).output();
  return code;
};

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
  lint: MutantLinter,
  abortSignal: AbortSignal,
): Promise<Status> => {
  await Deno.writeTextFile(file, applyMutant(original, mutant));
  try {
    // A mutant that produces code the linter rejects (e.g. `==` under
    // noDoubleEquals) is detected statically — killed before we spend a full
    // test run on it. See createLinter for why this can't mask a survivor.
    if (!(await lint(file))) return "killed";
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

interface RunMutantsOptions {
  abortSignal: AbortSignal;
  batchJobs: number;
  exhaustive: boolean;
  ignoreList: IgnoreList;
  isAborted: () => boolean;
  originals: Map<string, string>;
  restoreAll: () => void;
  results: MutantResult[];
  sourceFiles: string[];
  testFiles: string[];
  timeout: number;
  useHarness: boolean;
}

/** Baseline check, then the per-file/per-mutant loop, then the report. */
const runMutants = async (opts: RunMutantsOptions): Promise<number> => {
  const {
    abortSignal,
    batchJobs,
    exhaustive,
    ignoreList,
    isAborted,
    originals,
    restoreAll,
    results,
    sourceFiles,
    testFiles,
    timeout,
    useHarness,
  } = opts;

  console.log(dim("Running baseline (unmutated) tests…"));
  const baseline = await runTests(
    testFiles,
    BASELINE_TIMEOUT,
    batchJobs,
    abortSignal,
  );
  if (isAborted()) return 130;
  if (baseline.outcome !== "passed") {
    console.error(red(`\nBaseline tests did not pass (${baseline.outcome}).`));
    console.error(
      "Mutation testing needs a green baseline. Fix the tests, or add --harness",
    );
    console.error(
      "if these tests import the app / Stripe and need stripe-mock + built assets.",
    );
    return 1;
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

  // Under --harness the client bundles are built once; a mutant on a bundled
  // source must rebuild the affected bundle(s) or it would falsely survive.
  const rebuilder: AssetRebuilder | null = useHarness
    ? await createAssetRebuilder()
    : null;
  const lint = await createLinter();

  try {
    const plans: FileMutationPlan[] = [];
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
          lint,
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
        if (
          results.length % PROGRESS_INTERVAL === 0 ||
          results.length === totalMutants ||
          status !== "killed"
        ) {
          write("\n");
          console.log(
            formatProgressLine({
              completed: results.length,
              ignored: counts.ignored,
              killed: counts.killed,
              last: result,
              survived: counts.survived,
              timedOut: counts["timed-out"],
              total: totalMutants,
            }),
          );
        }
      }
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

  const exitCode = report(results);
  // The ignore-list is location-based, so it drifts as code moves. Re-check it
  // here — only for the files just mutated — and fail if any entry no longer
  // lines up with a real survivor, so it gets fixed instead of rotting.
  const problems = ignoreListProblems(ignoreList, results, sourceFiles);
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
  const signals: Deno.Signal[] = ["SIGINT", "SIGTERM"];
  for (const signal of signals) {
    try {
      Deno.addSignalListener(signal, onSignal);
    } catch {
      // signal handling may be unavailable (e.g. SIGTERM on Windows);
      // the finally below still restores.
    }
  }

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
    for (const signal of signals) {
      try {
        Deno.removeSignalListener(signal, onSignal);
      } catch {
        // matches the add above
      }
    }
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
