// Runs one check command and bounds it in time: a stalled checker must not
// hold the edit hook open, so the child is terminated after the timeout.
import { execFile } from "node:child_process";
import type { RunTool } from "#scripts/edit-checks/pipeline.ts";

export const CHECK_TIMEOUT_MS = 120_000;

// Inside the nix devshell the pinned deno is already on PATH. Outside it,
// nix develop provides it, as AGENTS.md requires for tools.
export const runnerPrefix = (
  env: Record<string, string | undefined>,
): [string, ...string[]] =>
  env.IN_NIX_SHELL ? ["deno"] : ["nix", "develop", "-c", "deno"];

export const createRunner = ({
  worktree,
  timeoutMs = CHECK_TIMEOUT_MS,
}: {
  worktree: string;
  timeoutMs?: number;
}): RunTool => {
  const prefix = runnerPrefix(process.env);

  return (args) =>
    new Promise((resolve) => {
      // The abort terminates the child; the flag tells a timeout apart
      // from other failures, and the timeout reports no captured output.
      const signal = AbortSignal.timeout(timeoutMs);
      let timedOut = false;
      signal.addEventListener(
        "abort",
        () => {
          timedOut = true;
        },
        { once: true },
      );
      let failure: Error | null = null;
      let output = "";
      // The checker must not join a surrounding coverage run: a child
      // spawned under DENO_COVERAGE_DIR records coverage for a tool
      // fixture the caller may delete.
      const env = { ...process.env };
      delete env.DENO_COVERAGE_DIR;
      execFile(
        prefix[0],
        [...prefix.slice(1), "run", "-A", ...args],
        { cwd: worktree, env, maxBuffer: 10 * 1024 * 1024, signal },
        (err, stdout, stderr) => {
          failure = err;
          output = `${stdout}\n${stderr}`;
        },
        // Resolving on close, not in the callback, keeps the resolve
        // behind the child process teardown.
      ).on("close", () => {
        if (timedOut) {
          resolve({
            ok: false,
            text: `check timed out after ${timeoutMs / 1000}s`,
          });
        } else if (failure !== null) {
          resolve({
            ok: false,
            text: `check hook could not run: ${failure.message}\n${output}`,
          });
        } else {
          resolve({ ok: true, text: output });
        }
      });
    });
};
