export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
  success: boolean;
}

export type RunCommand = (cmd: string[]) => Promise<CommandResult>;

/** Run a `git` subcommand through `run`. */
export const runGit = (
  run: RunCommand,
  args: string[],
): Promise<CommandResult> => run(["git", ...args]);

/** Trimmed stdout of a git command, or undefined when it fails or is empty. */
export const commandValue = async (
  run: RunCommand,
  args: string[],
): Promise<string | undefined> => {
  const result = await runGit(run, args);
  if (!result.success) return undefined;
  const value = result.stdout.trim();
  return value || undefined;
};

/** True when `run` executes inside a git work tree. */
export const isInsideWorkTree = async (run: RunCommand): Promise<boolean> =>
  (await runGit(run, ["rev-parse", "--is-inside-work-tree"])).success;
