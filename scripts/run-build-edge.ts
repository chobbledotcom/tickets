import type { BuildResult } from "./deploy-edge-lib.ts";

/**
 * Run `deno task build:edge` in `cwd`, inheriting stdio so the bundle build's
 * output streams straight through. Returns the child's exit code and success.
 */
export const runBuildEdge = async (cwd: string): Promise<BuildResult> => {
  const build = await new Deno.Command(Deno.execPath(), {
    args: ["task", "build:edge"],
    cwd,
    stderr: "inherit",
    stdout: "inherit",
  }).output();

  return { code: build.code, success: build.success };
};
