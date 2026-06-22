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

import { dim, green, red, write, yellow } from "../precommit/colors.ts";
import {
  projectRoot,
  STRIPE_MOCK_PORT,
  withTestHarness,
} from "../test-harness.ts";
import { type AssetRebuilder, createAssetRebuilder } from "./assets.ts";
import { applyMutant, generateMutants, type Mutant } from "./generate.ts";
import { isIgnored, loadIgnoreList } from "./ignore.ts";
import {
  formatSummaryLines,
  type MutantResult,
  rel,
  type Status,
  summarize,
  writeStepSummary,
} from "./summary.ts";

export interface MutationOptions {
  exhaustive: boolean;
  sourceFiles: string[];
  testFiles: string[];
  timeout: number;
  useHarness: boolean;
}

type Outcome = "failed" | "passed" | "timed-out";

const BASELINE_TIMEOUT = 120_000;
const TIMEOUT_MULTIPLIER = 3;

const testEnv = (): Record<string, string> => ({
  ...Deno.env.toObject(),
  NO_PROXY: "localhost,127.0.0.1,::1",
  no_proxy: "localhost,127.0.0.1,::1",
  STRIPE_MOCK_HOST: "localhost",
  STRIPE_MOCK_PORT: String(STRIPE_MOCK_PORT),
});

/** Run the test files once, returning the outcome and how long it took. */
const runTests = async (
  testFiles: string[],
  timeoutMs: number,
  abortSignal?: AbortSignal,
): Promise<{ durationMs: number; outcome: Outcome }> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = (): void => controller.abort();
  if (abortSignal?.aborted) controller.abort();
  else abortSignal?.addEventListener("abort", onAbort, { once: true });
  const startedAt = performance.now();
  try {
    const { code } = await new Deno.Command(Deno.execPath(), {
      args: ["test", "--no-check", "--allow-all", ...testFiles],
      cwd: projectRoot,
      env: testEnv(),
      signal: controller.signal,
      stderr: "null",
      stdout: "null",
    }).output();
    return {
      durationMs: performance.now() - startedAt,
      outcome: code === 0 ? "passed" : "failed",
    };
  } catch {
    return { durationMs: performance.now() - startedAt, outcome: "timed-out" };
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

/** Mutate the file, run the tests, and always restore the original. */
const evaluateMutant = async (
  file: string,
  original: string,
  mutant: Mutant,
  testFiles: string[],
  timeoutMs: number,
  assets: MutantAssetHooks | null,
  abortSignal: AbortSignal,
): Promise<Status> => {
  await Deno.writeTextFile(file, applyMutant(original, mutant));
  try {
    // A mutant that breaks the client-bundle build must not be tested against a
    // stale baseline asset (the tests would pass and it would falsely survive).
    // A failed build means the mutation is detected, so count it as killed.
    if (assets && !(await assets.rebuild())) return "killed";
    const { outcome } = await runTests(testFiles, timeoutMs, abortSignal);
    return toStatus(outcome);
  } finally {
    await Deno.writeTextFile(file, original);
    if (assets) await assets.restore();
  }
};

/**
 * Print the report (and the CI step summary), returning the exit code:
 * 0 = every mutant detected, 1 = survivors, 2 = inconclusive (no mutants, so
 * the run proved nothing — fail rather than report a vacuous 100% that would
 * let CI go green on a module with nothing to test).
 */
const report = (results: MutantResult[]): number => {
  const summary = summarize(results);
  for (const line of formatSummaryLines(summary)) console.log(line);
  writeStepSummary(summary);
  if (summary.effective === 0) return 2;
  return summary.survived === 0 ? 0 : 1;
};

interface RunMutantsOptions {
  abortSignal: AbortSignal;
  exhaustive: boolean;
  ignoreList: Set<string>;
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
  const baseline = await runTests(testFiles, BASELINE_TIMEOUT, abortSignal);
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

  // Under --harness the client bundles are built once; a mutant on a bundled
  // source must rebuild the affected bundle(s) or it would falsely survive.
  const rebuilder: AssetRebuilder | null = useHarness
    ? await createAssetRebuilder()
    : null;

  try {
    for (const file of sourceFiles) {
      if (isAborted()) break;
      const original = await Deno.readTextFile(file);
      originals.set(file, original);
      const affected = rebuilder ? rebuilder.affected(file) : [];
      const assets: MutantAssetHooks | null =
        rebuilder && affected.length > 0
          ? {
              rebuild: () => rebuilder.rebuild(affected),
              restore: () => rebuilder.restore(affected),
            }
          : null;
      const mutants = generateMutants(original, file, exhaustive);
      if (mutants.length === 0) {
        console.log(yellow(`  no mutable operators in ${rel(file)}`));
      } else {
        const note =
          affected.length > 0
            ? dim(` (rebuilding ${affected.length} bundle(s) per mutant)`)
            : "";
        console.log(dim(`  ${rel(file)}: ${mutants.length} mutants`) + note);
      }
      for (const mutant of mutants) {
        if (isAborted()) break;
        const outcome = await evaluateMutant(
          file,
          original,
          mutant,
          testFiles,
          perMutantTimeout,
          assets,
          abortSignal,
        );
        if (isAborted()) break;
        // A survivor recorded as known-equivalent is suppressed, not a failure.
        const status: Status =
          outcome === "survived" && isIgnored(ignoreList, file, mutant)
            ? "ignored"
            : outcome;
        results.push({ file, mutant, status });
        write(statusGlyph(status));
      }
      originals.delete(file);
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
  return report(results);
};

const mutate = async (options: MutationOptions): Promise<number> => {
  const { exhaustive, sourceFiles, testFiles, timeout } = options;
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
