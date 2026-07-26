// Signal handling is platform-dependent, so listeners are best-effort. The
// caller's normal promise cleanup remains the primary cleanup path.
const forEachTerminationSignal = (
  action: (signal: Deno.Signal) => void,
): void => {
  for (const signal of ["SIGINT", "SIGTERM"] as Deno.Signal[]) {
    try {
      action(signal);
    } catch {
      // The signal may not exist on this platform.
    }
  }
};

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
