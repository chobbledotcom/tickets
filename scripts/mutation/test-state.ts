import { join } from "node:path";
import { TEST_STATE_DIR_ENV } from "../../test/test-utils/test-state-env.ts";
import { denoExitCode } from "./child-process.ts";

export interface MutantTestState {
  cleanup(): Promise<void>;
  env: Record<string, string>;
}

export type MutantTestStateResult =
  | { status: "failed" | "timed-out" }
  | { state: MutantTestState; status: "ready" };

interface TestStateDeps {
  makeTempDir(): Promise<string>;
  remove(path: string): Promise<void>;
  run(
    dir: string,
    env: Record<string, string>,
    signal: AbortSignal,
  ): Promise<number>;
}

const realDeps: TestStateDeps = {
  makeTempDir: () => Deno.makeTempDir({ prefix: "tickets-mutant-state-" }),
  remove: (path) => Deno.remove(path, { recursive: true }),
  run: (dir, env, signal) =>
    denoExitCode(
      ["run", "-A", join(import.meta.dirname!, "build-test-state.ts"), dir],
      { env, signal, stderr: "null", stdout: "null" },
    ),
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
    const code = await deps.run(dir, builderEnv, signal);
    if (code !== 0) {
      await deps.remove(dir);
      return { status: "failed" };
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
    if (
      signal.aborted ||
      (error instanceof DOMException && error.name === "AbortError")
    ) {
      return { status: "timed-out" };
    }
    throw error;
  }
};
