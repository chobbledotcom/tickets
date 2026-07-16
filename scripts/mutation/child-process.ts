import { extendedBy } from "#fp";
import { commandExitCode } from "../deno-command.ts";

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

// Signal handling is platform-dependent (e.g. SIGTERM on Windows), so every
// add/remove is best-effort — callers must still clean up via finally/exit.
const forEachTerminationSignal = (
  action: (signal: Deno.Signal) => void,
): void => {
  for (const signal of ["SIGINT", "SIGTERM"] as Deno.Signal[]) {
    try {
      action(signal);
    } catch {
      // Best-effort; the caller's own cleanup still runs.
    }
  }
};

/** Apply one of Deno's listener methods (add or remove) to a handler for
 * every termination signal — the shared body of the register/unregister pair.
 * The method is looked up per call, so tests can stub the Deno namespace. */
const terminationSignalListeners =
  (method: "addSignalListener" | "removeSignalListener") =>
  (handler: () => void): void =>
    forEachTerminationSignal((signal) => Deno[method](signal, handler));

/** Register `handler` for SIGINT and SIGTERM. */
export const onTerminationSignals: (handler: () => void) => void =
  terminationSignalListeners("addSignalListener");

/** Unregister a `handler` previously passed to `onTerminationSignals`. */
export const offTerminationSignals: (handler: () => void) => void =
  terminationSignalListeners("removeSignalListener");
