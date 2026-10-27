import {
  type CapturedOutput,
  captureOutput,
  INHERIT_STDIO,
} from "#scripts/process.ts";

export type RunCommand = (
  cmd: string[],
  options?: { clearEnv?: boolean; cwd?: string; env?: Record<string, string> },
) => Promise<CapturedOutput>;

/** Split a command into [executable, args], rejecting an empty command. */
export const splitCommand = (
  cmd: string[],
  label = "command",
): [string, string[]] => {
  const [command, ...args] = cmd;
  if (!command) throw new Error(`No ${label} configured`);
  return [command, args];
};

/** Build a `Deno.Command` from a `[executable, ...args]` list plus the stdio
 * wiring for this run. */
const buildCommand = (
  cmd: string[],
  options: Omit<Deno.CommandOptions, "args">,
): Deno.Command => {
  const [command, args] = splitCommand(cmd);
  return new Deno.Command(command, { ...options, args });
};

/** Run a command, capturing its stdout/stderr as decoded strings. */
export const runCommand: RunCommand = async (cmd, options = {}) =>
  await captureOutput(
    buildCommand(cmd, { ...options, stderr: "piped", stdout: "piped" }),
  );

/** Run a command wired to the parent's stdio (for interactive steps). */
export const runInteractiveCommand: RunCommand = async (cmd) => {
  const status = await buildCommand(cmd, { ...INHERIT_STDIO }).spawn().status;

  return {
    code: status.code,
    stderr: "",
    stdout: "",
    success: status.success,
  };
};

/** Run a `git` subcommand through `run`. */
export const runGit = (
  run: RunCommand,
  args: string[],
): Promise<CapturedOutput> => run(["git", ...args]);

/** Trimmed stdout of a git command, or undefined when it fails or is empty. */
export const commandValue = async (
  run: RunCommand,
  args: string[],
): Promise<string | undefined> => {
  const result = await runGit(run, args);
  if (!result.success) return;
  const value = result.stdout.trim();
  return value || undefined;
};

/** The commit a ref resolves to, verified to exist — or undefined when it
 *  doesn't (an unfetched `origin/main`, a missing `HEAD`). */
export const verifyRef = (
  run: RunCommand,
  ref: string,
): Promise<string | undefined> =>
  commandValue(run, ["rev-parse", "--verify", ref]);

/** A function that reads a list of paths from a revision the merge base
 * names. The coverage ratchet and the test-quality gate both collect their
 * input files this way, so the signature gets a name instead of a copy. */
export type MergeBaseListReader = (
  run: RunCommand,
  mergeBase: string,
) => Promise<string[]>;

/** The merge base of HEAD and origin/main, or throw when origin/main is
 * absent so a ratchet never reads an empty base. `noun` names the check in
 * the error, e.g. "ratchet". */
export const mergeBaseOrThrow = async (
  run: RunCommand,
  noun: string,
): Promise<string> => {
  const mergeBase = await commandValue(run, [
    "merge-base",
    "HEAD",
    "origin/main",
  ]);
  if (mergeBase === undefined) {
    throw new Error(
      `The ${noun} needs origin/main. Run git fetch origin main first.`,
    );
  }
  return mergeBase;
};

/** True when `run` executes inside a git work tree. */
export const isInsideWorkTree = async (run: RunCommand): Promise<boolean> =>
  (await runGit(run, ["rev-parse", "--is-inside-work-tree"])).success;

/** Run `body` only when inside a git work tree; outside one, resolve to
 * undefined so a caller that gates its work on being in a repo bails cleanly. */
export const withinWorkTree = async <T>(
  run: RunCommand,
  body: () => Promise<T | undefined>,
): Promise<T | undefined> =>
  (await isInsideWorkTree(run)) ? body() : undefined;
