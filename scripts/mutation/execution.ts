import { partition } from "#fp";
import {
  type BiomeCommand,
  resolveBiomeCommand,
} from "#scripts/biome-command.ts";
import { commandExitCode } from "#scripts/deno-command.ts";
import { projectRoot } from "#scripts/project-root.ts";
import { isFeaturePath } from "#scripts/specs/paths.ts";
import { stripeMockEnv, stripeMockPortFromEnv } from "#scripts/stripe-mock.ts";
import { TEST_STATE_DIR_ENV } from "#test/test-utils/test-state-env.ts";
import { batchTestFiles } from "./batch.ts";
import { denoExitCode, envWith } from "./child-process.ts";
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

export type TestBatchRunner = (
  batch: string[],
  signal: AbortSignal,
  env: Record<string, string>,
) => Promise<number>;

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
    stderr: "null",
    stdout: "null",
  } as const;
  if (direct.length > 0) {
    const entries = await planIsolateEntries(direct);
    try {
      const code = await denoExitCode(
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
      if (code !== 0) return code;
    } finally {
      await entries.cleanup();
    }
  }
  return features.length === 0
    ? 0
    : await denoExitCode(
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
  signal: AbortSignal;
}

const runOneBatch = async (
  batch: string[],
  { controller, deps, env, signal }: BatchRunContext,
): Promise<Outcome | null> => {
  try {
    const code = await deps.runBatch(batch, controller.signal, env);
    if (code === 0) return null;
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
): Promise<{ durationMs: number; outcome: Outcome }> => {
  const controller = new AbortController();
  const forwardAbort = (): void => controller.abort(signal.reason);
  if (signal.aborted) forwardAbort();
  else signal.addEventListener("abort", forwardAbort, { once: true });
  const startedAt = performance.now();
  try {
    const [features, direct] = partition(isFeaturePath)(testFiles);
    const cursor = { batches: batchTestFiles(direct), next: 0 };
    const context = { controller, deps, env, signal };
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
    return { durationMs: performance.now() - startedAt, outcome };
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
