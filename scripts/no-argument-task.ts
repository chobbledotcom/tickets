import type { ScriptIo } from "#scripts/script-runner.ts";

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
