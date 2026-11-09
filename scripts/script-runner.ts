export interface ScriptIo {
  args: string[];
  getEnv: (key: string) => string | undefined;
  stderr: (line: string) => void;
  stdout: (line: string) => void;
}

/** A task that takes no arguments: its inputs, its usage line, and its work. */
export type NoArgumentTask<Io> = (
  io: Io,
  usage: string,
  run: () => Promise<number>,
) => Promise<number>;

/**
 * Make a task that takes no arguments. If it gets any, it prints the usage line
 * and fails. `failed` turns an error from the work into an exit code.
 */
export const taskWithoutArguments =
  <Io extends Pick<ScriptIo, "args" | "stderr">>(
    failed: (io: Io, error: unknown) => number,
  ): NoArgumentTask<Io> =>
  async (io, usage, run) => {
    if (io.args.length !== 0) {
      io.stderr(usage);
      return 1;
    }
    try {
      return await run();
    } catch (error) {
      return failed(io, error);
    }
  };

/** Give a console task its standard Deno inputs and exit with its result. */
export const runDenoScript = async (
  run: (io: ScriptIo) => Promise<number>,
): Promise<never> => {
  const exitCode = await run({
    args: Deno.args,
    getEnv: (key) => Deno.env.get(key),
    stderr: (line) => console.error(line),
    stdout: (line) => console.log(line),
  });
  return Deno.exit(exitCode);
};
