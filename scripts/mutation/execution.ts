import { partition } from "#fp";
import {
  type BiomeCommand,
  resolveBiomeCommand,
} from "#scripts/biome-command.ts";
import { commandExitCode } from "#scripts/deno-command.ts";
import { projectRoot } from "#scripts/project-root.ts";
import { isFeaturePath } from "#scripts/specs/paths.ts";
import { stripeMockEnv, stripeMockPortFromEnv } from "#scripts/stripe-mock.ts";
import { TEST_STATE_DIR_ENV } from "#test-utils/test-state-env.ts";
import { batchTestFiles } from "./batch.ts";
import { denoExitCode, denoExitDetail, envWith } from "./child-process.ts";
import { planIsolateEntries } from "./isolate-entry.ts";
import type { EvaluationStatus } from "./summary.ts";

export type Outcome = "cancelled" | "failed" | "passed";

export interface StaticGate {
  exit(file: string, workspace: string, signal: AbortSignal): Promise<number>;
  label: string;
  phase: "lint" | "type-check";
  remedy: string[];
}

export interface TestRunConfig {
  batchJobs: number;
  env: Record<string, string>;
  testFiles: string[];
}

/** One `deno test` batch: its exit code and captured output. */
export interface BatchRunResult {
  code: number;
  output: string;
}

/** The batch that failed a run, kept so the caller can say which one and
 *  what it printed. */
export interface BatchFailure {
  batch: string[];
  output: string;
}

export interface TestRunResult {
  durationMs: number;
  failure?: BatchFailure;
  outcome: Outcome;
}

export type TestBatchRunner = (
  batch: string[],
  signal: AbortSignal,
  env: Record<string, string>,
) => Promise<BatchRunResult>;

/** The environment a mutation run's child test process inherits. The stripe-mock
 * port is a parameter rather than a read of this process's own environment, so
 * a caller can say which one without changing it for everyone else. */
export const testEnv = (
  port = stripeMockPortFromEnv(),
): Record<string, string> => envWith(stripeMockEnv(port));

export const mutantTestEnv = (
  baseEnv: Record<string, string>,
  rebuildTestState: boolean,
): Record<string, string> => {
  const env = { ...baseEnv };
  if (rebuildTestState) delete env[TEST_STATE_DIR_ENV];
  return env;
};

export interface StaticGateDeps {
  commandExit(command: string, options: Deno.CommandOptions): Promise<number>;
  denoExit(args: string[], options: Deno.CommandOptions): Promise<number>;
  resolveBiome(args: string[]): Promise<BiomeCommand>;
}

const realGateDeps: StaticGateDeps = {
  commandExit: commandExitCode,
  denoExit: denoExitCode,
  resolveBiome: resolveBiomeCommand,
};

const quietCommandOptions = (
  workspace: string,
  signal: AbortSignal,
): Deno.CommandOptions => ({
  cwd: workspace,
  signal,
  stderr: "null",
  stdout: "null",
});

const createLinter = async (deps: StaticGateDeps): Promise<StaticGate> => {
  const resolved = await deps.resolveBiome([]);
  return {
    exit: (file, workspace, signal) =>
      deps.commandExit(resolved.command, {
        args: [
          ...resolved.args,
          "lint",
          "--error-on-warnings",
          "--no-errors-on-unmatched",
          file,
        ],
        ...quietCommandOptions(workspace, signal),
      }),
    label: "lint",
    phase: "lint",
    remedy: [
      "The mutation lint gate needs a lint-clean target and a working Biome.",
      "Run `deno task lint` and fix any errors, then retry.",
    ],
  };
};

const createTypeChecker = (deps: StaticGateDeps): StaticGate => ({
  exit: (file, workspace, signal) =>
    deps.denoExit(["check", file], {
      ...quietCommandOptions(workspace, signal),
    }),
  label: "type-check",
  phase: "type-check",
  remedy: [
    "The mutation type-check gate needs a type-clean target and working Deno.",
    "Run `deno task typecheck` and fix any errors, then retry.",
  ],
});

export const createStaticGates = async (
  deps: StaticGateDeps = realGateDeps,
): Promise<StaticGate[]> => [await createLinter(deps), createTypeChecker(deps)];

const runTestBatch: TestBatchRunner = async (batch, signal, env) => {
  const [features, direct] = partition(isFeaturePath)(batch);
  const options = {
    cwd: projectRoot,
    env,
    signal,
  } as const;
  const emptyOutput = (): BatchRunResult => ({ code: 0, output: "" });
  if (direct.length > 0) {
    const entries = await planIsolateEntries(direct);
    try {
      const result = await denoExitDetail(
        [
          "test",
          "--no-check",
          "--allow-all",
          "--parallel",
          "--preload",
          "./test/test-utils/preload.ts",
          "--v8-flags=--expose-gc",
          ...entries.runArgs,
        ],
        options,
      );
      if (result.code !== 0) return result;
    } finally {
      await entries.cleanup();
    }
  }
  return features.length === 0
    ? emptyOutput()
    : await denoExitDetail(
        [
          "run",
          "--v8-flags=--expose-gc",
          "-A",
          "./scripts/run-specs.ts",
          ...features,
        ],
        options,
      );
};

export interface TestExecutionDeps {
  runBatch: TestBatchRunner;
}

const realTestDeps: TestExecutionDeps = { runBatch: runTestBatch };

interface BatchCursor {
  batches: string[][];
  next: number;
}

interface BatchRunContext {
  controller: AbortController;
  deps: TestExecutionDeps;
  env: Record<string, string>;
  /** First failing batch, kept for the run's report. */
  failure: { current: BatchFailure | null };
  signal: AbortSignal;
}

const runOneBatch = async (
  batch: string[],
  { controller, deps, env, failure, signal }: BatchRunContext,
): Promise<Outcome | null> => {
  try {
    const result = await deps.runBatch(batch, controller.signal, env);
    // An aborted run terminated this child, so its exit status says nothing
    // about the tests; report the cancellation, never a bogus failure.
    if (signal.aborted) return "cancelled";
    if (result.code === 0) return null;
    failure.current ??= { batch, output: result.output };
    controller.abort();
    return "failed";
  } catch (error) {
    if (signal.aborted) return "cancelled";
    if (controller.signal.aborted) return null;
    throw error;
  }
};

const runBatchWorker = async (
  cursor: BatchCursor,
  context: BatchRunContext,
): Promise<Outcome | null> => {
  const { controller, signal } = context;
  while (!controller.signal.aborted) {
    const batch = cursor.batches[cursor.next++];
    if (!batch) return null;
    const outcome = await runOneBatch(batch, context);
    if (outcome) return outcome;
  }
  if (signal.aborted) return "cancelled";
  return null;
};

export const runTests = async (
  { batchJobs, env, testFiles }: TestRunConfig,
  signal: AbortSignal,
  deps: TestExecutionDeps = realTestDeps,
): Promise<TestRunResult> => {
  const controller = new AbortController();
  const forwardAbort = (): void => controller.abort(signal.reason);
  if (signal.aborted) forwardAbort();
  else signal.addEventListener("abort", forwardAbort, { once: true });
  const startedAt = performance.now();
  try {
    const [features, direct] = partition(isFeaturePath)(testFiles);
    const cursor = { batches: batchTestFiles(direct), next: 0 };
    const failure = { current: null as BatchFailure | null };
    const context = { controller, deps, env, failure, signal };
    const jobs = Math.min(
      Math.max(1, batchJobs),
      Math.max(1, cursor.batches.length),
    );
    const outcomes = await Promise.all(
      Array.from({ length: jobs }, () => runBatchWorker(cursor, context)),
    );
    let outcome: Outcome = outcomes.includes("failed")
      ? "failed"
      : outcomes.includes("cancelled")
        ? "cancelled"
        : "passed";
    if (outcome === "passed" && features.length > 0) {
      outcome = (await runOneBatch(features, context)) ?? "passed";
    }
    const durationMs = performance.now() - startedAt;
    return failure.current === null
      ? { durationMs, outcome }
      : { durationMs, failure: failure.current, outcome };
  } finally {
    signal.removeEventListener("abort", forwardAbort);
  }
};

export const toStatus = (outcome: Outcome): EvaluationStatus =>
  outcome === "passed"
    ? "survived"
    : outcome === "failed"
      ? "killed"
      : "cancelled";
