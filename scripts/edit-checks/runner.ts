// Runs one check command and bounds it in time: a stalled checker must not
// hold the edit hook open, so the child is terminated after the timeout.
import { execFile } from "node:child_process";
import type { RunTool } from "#scripts/edit-checks/pipeline.ts";

export const CHECK_TIMEOUT_MS = 120_000;

// Inside the devenv shell the pinned deno is already on PATH. Outside it,
// devenv shell provides it, as AGENTS.md requires for tools.
export const runnerPrefix = (
  env: Record<string, string | undefined>,
): [string, ...string[]] =>
  env.IN_NIX_SHELL ? ["deno"] : ["devenv", "shell", "--", "deno"];

export const createRunner =
  ({
    worktree,
    timeoutMs = CHECK_TIMEOUT_MS,
    prefix,
  }: {
    worktree: string;
    timeoutMs?: number;
    prefix: [string, ...string[]];
  }): RunTool =>
  (args) =>
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
      const child = execFile(
        prefix[0],
        [...prefix.slice(1), "run", "-A", ...args],
        { cwd: worktree, env, maxBuffer: 10 * 1024 * 1024, signal },
        (err, stdout, stderr) => {
          failure = err;
          output = `${stdout}\n${stderr}`;
          if (child.pid === undefined) resolve(run(failure));
        },
        // Resolving on close, not in the callback, keeps the resolve
        // behind the child process teardown. A command that never spawned
        // sends no close, so the spawn-failure error resolves above.
      ).on("close", () => resolve(run(failure)));

      function run(err: Error | null): { ok: boolean; text: string } {
        if (timedOut) {
          return {
            ok: false,
            text: `check timed out after ${timeoutMs / 1000}s`,
          };
        }
        if (err !== null) {
          return {
            ok: false,
            text: `check hook could not run: ${err.message}\n${output}`,
          };
        }
        return { ok: true, text: output };
      }
    });
