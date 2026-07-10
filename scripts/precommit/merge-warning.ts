import {
  commandValue,
  isInsideWorkTree,
  type RunCommand,
  runGit,
} from "./git.ts";

export type { CommandResult, RunCommand } from "./git.ts";

/** Split a command into [executable, args], rejecting an empty command. */
const splitCommand = (cmd: string[]): [string, string[]] => {
  const [command, ...args] = cmd;
  if (!command) throw new Error("No command configured");
  return [command, args];
};

export const runCommand: RunCommand = async (cmd) => {
  const [command, args] = splitCommand(cmd);
  const output = await new Deno.Command(command, {
    args,
    stderr: "piped",
    stdout: "piped",
  }).output();

  const decoder = new TextDecoder();
  return {
    code: output.code,
    stderr: decoder.decode(output.stderr),
    stdout: decoder.decode(output.stdout),
    success: output.success,
  };
};

export const runInteractiveCommand: RunCommand = async (cmd) => {
  const [command, args] = splitCommand(cmd);
  const status = await new Deno.Command(command, {
    args,
    stderr: "inherit",
    stdin: "inherit",
    stdout: "inherit",
  }).spawn().status;

  return {
    code: status.code,
    stderr: "",
    stdout: "",
    success: status.success,
  };
};

export const parseMergeTreeConflictedPaths = (stdout: string): string[] => {
  const lines = stdout.split(/\r?\n/);
  const paths: string[] = [];

  for (const line of lines.slice(1)) {
    if (line === "") break;
    paths.push(line);
  }

  return Array.from(new Set(paths));
};

export const getMergeConflictWarning = async (
  run: RunCommand,
): Promise<string | undefined> => {
  if (!(await isInsideWorkTree(run))) return undefined;

  const originUrl = await commandValue(run, ["remote", "get-url", "origin"]);
  const head = await commandValue(run, ["rev-parse", "--verify", "HEAD"]);
  const originMain = await commandValue(run, [
    "rev-parse",
    "--verify",
    "origin/main",
  ]);
  const mergeBase = await commandValue(run, [
    "merge-base",
    "HEAD",
    "origin/main",
  ]);
  const candidateTree = await commandValue(run, ["write-tree"]);
  if (!originUrl || !head || !originMain || !mergeBase || !candidateTree) {
    return undefined;
  }

  const result = await runGit(run, [
    "merge-tree",
    "--write-tree",
    "--name-only",
    "--merge-base",
    mergeBase,
    candidateTree,
    "origin/main",
  ]);
  if (result.code !== 1) return undefined;

  const conflictCount = parseMergeTreeConflictedPaths(result.stdout).length;
  if (conflictCount === 0) return undefined;

  return `Heads up - this branch has ${conflictCount} merge conflicts against ${originUrl}`;
};
