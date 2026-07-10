/** Run `deno <args>` to completion and return its exit code. */
export const denoExitCode = async (
  args: string[],
  options: Omit<Deno.CommandOptions, "args"> = {},
): Promise<number> => {
  const { code } = await new Deno.Command(Deno.execPath(), {
    args,
    ...options,
  }).output();
  return code;
};

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

/** Register `handler` for SIGINT and SIGTERM. */
export const onTerminationSignals = (handler: () => void): void =>
  forEachTerminationSignal((signal) => Deno.addSignalListener(signal, handler));

/** Unregister a `handler` previously passed to `onTerminationSignals`. */
export const offTerminationSignals = (handler: () => void): void =>
  forEachTerminationSignal((signal) =>
    Deno.removeSignalListener(signal, handler),
  );
