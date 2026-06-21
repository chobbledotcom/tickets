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

import { bold, dim, green, red, write, yellow } from "../precommit/colors.ts";
import {
  projectRoot,
  STRIPE_MOCK_PORT,
  withTestHarness,
} from "../test-harness.ts";
import { type AssetRebuilder, createAssetRebuilder } from "./assets.ts";
import { applyMutant, generateMutants, type Mutant } from "./generate.ts";

export interface MutationOptions {
  exhaustive: boolean;
  sourceFiles: string[];
  testFiles: string[];
  timeout: number;
  useHarness: boolean;
}

type Status = "killed" | "survived" | "timed-out";
type Outcome = "failed" | "passed" | "timed-out";

interface MutantResult {
  file: string;
  mutant: Mutant;
  status: Status;
}

const BASELINE_TIMEOUT = 120_000;
const TIMEOUT_MULTIPLIER = 3;

const rel = (path: string): string =>
  path.startsWith(`${projectRoot}/`)
    ? path.slice(projectRoot.length + 1)
    : path;

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
): Promise<{ durationMs: number; outcome: Outcome }> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
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
): Promise<Status> => {
  await Deno.writeTextFile(file, applyMutant(original, mutant));
  try {
    // A mutant that breaks the client-bundle build must not be tested against a
    // stale baseline asset (the tests would pass and it would falsely survive).
    // A failed build means the mutation is detected, so count it as killed.
    if (assets && !(await assets.rebuild())) return "killed";
    const { outcome } = await runTests(testFiles, timeoutMs);
    return toStatus(outcome);
  } finally {
    await Deno.writeTextFile(file, original);
    if (assets) await assets.restore();
  }
};

const tally = (results: MutantResult[], status: Status): number =>
  results.filter((result) => result.status === status).length;

const report = (results: MutantResult[]): number => {
  const killed = tally(results, "killed");
  const survived = tally(results, "survived");
  const timedOut = tally(results, "timed-out");
  const total = results.length;
  const detected = killed + timedOut;
  const score = total === 0 ? 100 : (detected / total) * 100;

  console.log(bold("\nMutation testing summary"));
  console.log(`  mutants:   ${total}`);
  console.log(`  ${green("killed:")}    ${killed}`);
  console.log(`  ${yellow("timed out:")} ${timedOut}`);
  console.log(`  ${red("survived:")}  ${survived}`);
  console.log(
    `  ${bold("score:")}     ${score.toFixed(1)}%  (detected ${detected}/${total})`,
  );

  if (survived === 0) {
    console.log(green("\nAll mutants were detected."));
    return 0;
  }

  console.log(red("\nSurvivors — these mutations did not fail any test:"));
  for (const result of results) {
    if (result.status !== "survived") continue;
    const { column, line, newOperator, operator } = result.mutant;
    console.log(
      `  ${rel(result.file)}:${line}:${column}  ${bold(operator)} → ${bold(
        newOperator,
      )}`,
    );
  }
  return 1;
};

const mutate = async (options: MutationOptions): Promise<number> => {
  const { exhaustive, sourceFiles, testFiles, timeout } = options;

  console.log(dim("Running baseline (unmutated) tests…"));
  const baseline = await runTests(testFiles, BASELINE_TIMEOUT);
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
  const rebuilder: AssetRebuilder | null = options.useHarness
    ? await createAssetRebuilder()
    : null;

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
  const onSignal = (): void => {
    restoreAll();
    Deno.exit(130);
  };
  // Trap interrupts AND termination: a CI/wrapper SIGTERM mid-mutant would
  // otherwise kill us before the finally below runs, leaving the in-place
  // mutant written over the tracked source file.
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
    for (const file of sourceFiles) {
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
        const status = await evaluateMutant(
          file,
          original,
          mutant,
          testFiles,
          perMutantTimeout,
          assets,
        );
        results.push({ file, mutant, status });
        write(statusGlyph(status));
      }
      originals.delete(file);
    }
  } finally {
    for (const signal of signals) {
      try {
        Deno.removeSignalListener(signal, onSignal);
      } catch {
        // matches the add above
      }
    }
    restoreAll();
    rebuilder?.stop();
  }
  write("\n");

  return report(results);
};

/** Entry point: run mutation testing, returning a process exit code. */
export const runMutationTesting = (
  options: MutationOptions,
): Promise<number> =>
  options.useHarness ? withTestHarness(() => mutate(options)) : mutate(options);
