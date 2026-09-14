import { extendedBy } from "#fp";
import { commandDetail } from "#scripts/deno-command.ts";

type DenoRunOptions = Omit<Deno.CommandOptions, "args" | "clearEnv">;

/** Run `deno <args>` capturing its exit code and output text, so a failed
 *  test batch can report what the child printed. An explicit env is the
 *  child's complete environment, so removing a parent variable works. */
export const denoExitDetail = (
  args: string[],
  options: DenoRunOptions = {},
): Promise<{ code: number; output: string }> =>
  commandDetail(Deno.execPath(), {
    args,
    ...options,
    clearEnv: options.env !== undefined,
  });

/** Run `deno <args>` to completion and return its exit code. */
export const denoExitCode = (
  args: string[],
  options?: DenoRunOptions,
): Promise<number> =>
  denoExitDetail(args, options ?? {}).then(({ code }) => code);

/** The current process env plus the given extra variables — the env handed to
 * a spawned child process. */
export const envWith = (
  extras: Record<string, string>,
): Record<string, string> => extendedBy(extras)(Deno.env.toObject());
