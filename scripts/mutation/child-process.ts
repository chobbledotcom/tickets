import { extendedBy } from "#fp";
import { commandExitCode } from "#scripts/deno-command.ts";

/** Run `deno <args>` to completion and return its exit code. An explicit env
 * is the child's complete environment, so removing a parent variable works. */
export const denoExitCode = (
  args: string[],
  options: Omit<Deno.CommandOptions, "args" | "clearEnv"> = {},
): Promise<number> =>
  commandExitCode(Deno.execPath(), {
    args,
    ...options,
    clearEnv: options.env !== undefined,
  });

/** The current process env plus the given extra variables — the env handed to
 * a spawned child process. */
export const envWith = (
  extras: Record<string, string>,
): Record<string, string> => extendedBy(extras)(Deno.env.toObject());
