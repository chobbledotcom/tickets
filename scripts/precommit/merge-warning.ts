export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
  success: boolean;
}

export type RunCommand = (cmd: string[]) => Promise<CommandResult>;

export const runCommand: RunCommand = async (
  cmd: string[],
): Promise<CommandResult> => {
  const [command, ...args] = cmd;
  if (!command) throw new Error("No command configured");

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

export const runInteractiveCommand: RunCommand = async (
  cmd: string[],
): Promise<CommandResult> => {
  const [command, ...args] = cmd;
  if (!command) throw new Error("No command configured");

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

const runGit = (run: RunCommand, args: string[]): Promise<CommandResult> =>
  run(["git", ...args]);

const commandValue = async (
  run: RunCommand,
  args: string[],
): Promise<string | undefined> => {
  const result = await runGit(run, args);
  if (!result.success) return undefined;
  const value = result.stdout.trim();
  return value || undefined;
};

export const getMergeConflictWarning = async (
  run: RunCommand,
): Promise<string | undefined> => {
  const inWorkTree = await runGit(run, ["rev-parse", "--is-inside-work-tree"]);
  if (!inWorkTree.success) return undefined;

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
