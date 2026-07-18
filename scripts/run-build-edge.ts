import type { BuildResult } from "./deploy-edge-lib.ts";
import { runDeno } from "./process.ts";

/**
 * Run `deno task build:edge` in `cwd`, inheriting stdio so the bundle build's
 * output streams straight through. Returns the child's exit code and success.
 */
export const runBuildEdge = async (cwd: string): Promise<BuildResult> => {
  const build = await runDeno(["task", "build:edge"], cwd);

  return { code: build.code, success: build.success };
};
