import { join } from "node:path";
import { denoCommand, removeTree } from "#scripts/process.ts";
import { TEST_STATE_DIR_ENV } from "#test-utils/test-state-env.ts";

export interface MutantTestState {
  cleanup(): Promise<void>;
  env: Record<string, string>;
}

export type MutantTestStateResult =
  | { message: string; status: "failed" }
  | { status: "cancelled" }
  | { state: MutantTestState; status: "ready" };

interface StateBuilderOutput {
  code: number;
  stderr: string;
}

interface TestStateDeps {
  makeTempDir(): Promise<string>;
  remove(path: string): Promise<void>;
  run(
    dir: string,
    env: Record<string, string>,
    signal: AbortSignal,
  ): Promise<StateBuilderOutput>;
}

const realDeps: TestStateDeps = {
  makeTempDir: () => Deno.makeTempDir({ prefix: "tickets-mutant-state-" }),
  remove: removeTree,
  run: async (dir, env, signal) => {
    const output = await denoCommand(
      ["run", "-A", join(import.meta.dirname!, "build-test-state.ts"), dir],
      {
        clearEnv: true,
        env,
        signal,
        stderr: "piped",
        stdout: "null",
      },
    ).output();
    return {
      code: output.code,
      stderr: new TextDecoder().decode(output.stderr),
    };
  },
};

/** Build one state snapshot from the current mutant in a fresh process. Every
 * integration-test batch for that mutant receives the same read-only state. */
export const createMutantTestState = async (
  baseEnv: Record<string, string>,
  signal: AbortSignal,
  deps: TestStateDeps = realDeps,
): Promise<MutantTestStateResult> => {
  const dir = await deps.makeTempDir();
  const builderEnv = { ...baseEnv };
  delete builderEnv[TEST_STATE_DIR_ENV];
  try {
    const output = await deps.run(dir, builderEnv, signal);
    if (output.code !== 0) {
      await deps.remove(dir);
      return { message: output.stderr.trim(), status: "failed" };
    }
    return {
      state: {
        cleanup: () => deps.remove(dir),
        env: { ...baseEnv, [TEST_STATE_DIR_ENV]: dir },
      },
      status: "ready",
    };
  } catch (error) {
    await deps.remove(dir);
    if (signal.aborted) return { status: "cancelled" };
    throw error;
  }
};
