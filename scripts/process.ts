import nodeProcess from "node:process";

/** Wire a child process's three stdio streams straight to the parent's — for
 *  interactive or inherited runs where the child shares the same terminal. */
export const INHERIT_STDIO = {
  stderr: "inherit",
  stdin: "inherit",
  stdout: "inherit",
} as const;

/** Run the current Deno executable with inherited output. */
export const denoCommand = (
  args: string[],
  options: Omit<Deno.CommandOptions, "args"> = {},
): Deno.Command =>
  new Deno.Command(Deno.execPath(), {
    ...options,
    args,
  });

export const runDeno = (
  args: string[],
  cwd: string,
): Promise<Deno.CommandOutput> =>
  denoCommand(args, {
    cwd,
    stderr: "inherit",
    stdout: "inherit",
  }).output();

/** What a captured command run tells us: its result plus its decoded output. */
export interface CapturedOutput {
  code: number;
  stderr: string;
  stdout: string;
  success: boolean;
}

/** Run a command that has its output piped, and decode both streams as text. */
export const captureOutput = async (
  command: Deno.Command,
): Promise<CapturedOutput> => {
  const output = await command.output();
  const decoder = new TextDecoder();
  return {
    code: output.code,
    stderr: decoder.decode(output.stderr),
    stdout: decoder.decode(output.stdout),
    success: output.success,
  };
};

export const removeTree = (path: string): Promise<void> =>
  Deno.remove(path, { recursive: true });

const beforeTimeout = async (
  status: Promise<unknown>,
  timeoutMs: number,
): Promise<boolean> => {
  let timeout = 0;
  const delayed = new Promise<boolean>((resolve) => {
    timeout = setTimeout(() => resolve(false), timeoutMs);
  });
  try {
    return await Promise.race([status.then(() => true), delayed]);
  } finally {
    clearTimeout(timeout);
  }
};

export const processExists = (pid: number): boolean => {
  try {
    nodeProcess.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

export const stopProcessNow = (process: Deno.ChildProcess): void => {
  try {
    process.kill("SIGKILL");
  } catch {
    // It may already have exited.
  }
};

export const stopProcess = async (
  process: Deno.ChildProcess,
  timeoutMs: number,
  afterStop: () => Promise<void> = () => Promise.resolve(),
): Promise<void> => {
  process.ref();
  const status = process.status;
  try {
    try {
      process.kill();
    } catch {
      // It may already have exited.
    }
    if (!(await beforeTimeout(status, timeoutMs))) {
      stopProcessNow(process);
      await status.catch(() => {});
    }
  } finally {
    await afterStop();
  }
};
