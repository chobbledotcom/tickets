import { commandExitCode } from "#scripts/deno-command.ts";
import { projectRoot } from "#scripts/project-root.ts";
import { stripeMockEnv } from "#scripts/stripe-mock.ts";
import { TEST_STATE_DIR_ENV } from "#test/test-utils/test-state-env.ts";
import { batchTestFiles } from "./batch.ts";
import { denoExitCode, envWith } from "./child-process.ts";
import type { Status } from "./summary.ts";

export type Outcome = "failed" | "passed" | "timed-out";

export interface StaticGate {
  exit(file: string, signal: AbortSignal): Promise<number>;
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

export const testEnv = (): Record<string, string> => envWith(stripeMockEnv());

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
  whichBiome(): Promise<boolean>;
}

const realGateDeps: StaticGateDeps = {
  commandExit: commandExitCode,
  denoExit: denoExitCode,
  whichBiome: async () => {
    const output = await new Deno.Command("which", {
      args: ["biome"],
    }).output();
    return output.success;
  },
};

const resolveBiome = async (
  deps: StaticGateDeps,
): Promise<{ bin: string; pre: string[] }> => {
  try {
    if (await deps.whichBiome()) return { bin: "biome", pre: [] };
  } catch {
    // Falling back to the package is the supported behavior when `which` or
    // the native binary is unavailable.
  }
  return { bin: Deno.execPath(), pre: ["run", "-A", "npm:@biomejs/biome"] };
};

const quietCommandOptions = (signal: AbortSignal): Deno.CommandOptions => ({
  cwd: projectRoot,
  signal,
  stderr: "null",
  stdout: "null",
});

const createLinter = async (deps: StaticGateDeps): Promise<StaticGate> => {
  const { bin, pre } = await resolveBiome(deps);
  return {
    exit: (file, signal) =>
      deps.commandExit(bin, {
        args: [...pre, "lint", "--no-errors-on-unmatched", file],
        ...quietCommandOptions(signal),
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
  exit: (file, signal) =>
    deps.denoExit(["check", file], {
      ...quietCommandOptions(signal),
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

const runTestBatch: TestBatchRunner = (batch, signal, env) =>
  denoExitCode(
    [
      "test",
      "--no-check",
      "--allow-all",
      "--parallel",
      "--preload",
      "./test/test-utils/preload.ts",
      "--v8-flags=--expose-gc",
      ...batch,
    ],
    {
      cwd: projectRoot,
      env,
      signal,
      stderr: "null",
      stdout: "null",
    },
  );

export interface TestExecutionDeps {
  runBatch: TestBatchRunner;
}

const realTestDeps: TestExecutionDeps = { runBatch: runTestBatch };

interface BatchCursor {
  batches: string[][];
  next: number;
}

const runBatchWorker = async (
  cursor: BatchCursor,
  controller: AbortController,
  signal: AbortSignal,
  env: Record<string, string>,
  deps: TestExecutionDeps,
): Promise<Outcome | null> => {
  while (!controller.signal.aborted) {
    const batch = cursor.batches[cursor.next++];
    if (!batch) return null;
    try {
      const code = await deps.runBatch(batch, controller.signal, env);
      if (code !== 0) {
        controller.abort();
        return "failed";
      }
    } catch (error) {
      if (signal.aborted) return "timed-out";
      if (controller.signal.aborted) return null;
      throw error;
    }
  }
  if (signal.aborted) return "timed-out";
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
    const cursor = { batches: batchTestFiles(testFiles), next: 0 };
    const jobs = Math.min(
      Math.max(1, batchJobs),
      Math.max(1, cursor.batches.length),
    );
    const outcomes = await Promise.all(
      Array.from({ length: jobs }, () =>
        runBatchWorker(cursor, controller, signal, env, deps),
      ),
    );
    const outcome = outcomes.includes("failed")
      ? "failed"
      : outcomes.includes("timed-out")
        ? "timed-out"
        : "passed";
    return { durationMs: performance.now() - startedAt, outcome };
  } finally {
    signal.removeEventListener("abort", forwardAbort);
  }
};

export const toStatus = (outcome: Outcome): Status =>
  outcome === "passed"
    ? "survived"
    : outcome === "failed"
      ? "killed"
      : "timed-out";
