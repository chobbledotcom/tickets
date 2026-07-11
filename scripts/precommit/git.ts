export interface CommandResult {
  code: number;
  stderr: string;
  stdout: string;
  success: boolean;
}

export type RunCommand = (cmd: string[]) => Promise<CommandResult>;

/** Split a command into [executable, args], rejecting an empty command. */
export const splitCommand = (
  cmd: string[],
  label = "command",
): [string, string[]] => {
  const [command, ...args] = cmd;
  if (!command) throw new Error(`No ${label} configured`);
  return [command, args];
};

/** Run a command, capturing its stdout/stderr as decoded strings. */
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

/** Run a command wired to the parent's stdio (for interactive steps). */
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
  if (!result.success) return;
  const value = result.stdout.trim();
  return value || undefined;
};

/** True when `run` executes inside a git work tree. */
export const isInsideWorkTree = async (run: RunCommand): Promise<boolean> =>
  (await runGit(run, ["rev-parse", "--is-inside-work-tree"])).success;
