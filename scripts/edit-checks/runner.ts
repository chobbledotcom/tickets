// Runs one check command and bounds it in time: a stalled checker must not
// hold the edit hook open, so the child is terminated after the timeout.

import type { RunTool } from "#scripts/edit-checks/pipeline.ts";
import { captureOutput } from "#scripts/process.ts";
import { errorMessage } from "#shared/error-message.ts";

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
  async (args) => {
    // The abort terminates the child. A timeout reports no captured output.
    const signal = AbortSignal.timeout(timeoutMs);
    try {
      // The checker must not join a surrounding coverage run: a child
      // spawned under DENO_COVERAGE_DIR records coverage for a tool
      // fixture the caller may delete.
      const env = Object.fromEntries(
        Object.entries(Deno.env.toObject()).filter(
          ([name]) => name !== "DENO_COVERAGE_DIR",
        ),
      );
      const output = await captureOutput(
        new Deno.Command(prefix[0], {
          args: [...prefix.slice(1), "run", "-A", ...args],
          cwd: worktree,
          env,
          signal,
          stderr: "piped",
          stdout: "piped",
        }),
      );
      // The signal's SIGTERM lands as an ordinary exit, so the timeout is
      // checked against the signal, not the child's status.
      if (signal.aborted) {
        return {
          ok: false,
          text: `check timed out after ${timeoutMs / 1000}s`,
        };
      }
      return {
        ok: output.success,
        text: output.stdout + output.stderr,
      };
    } catch (error) {
      if (signal.aborted) {
        return {
          ok: false,
          text: `check timed out after ${timeoutMs / 1000}s`,
        };
      }
      return {
        ok: false,
        text: `check hook could not run: ${errorMessage(error)}`,
      };
    }
  };
