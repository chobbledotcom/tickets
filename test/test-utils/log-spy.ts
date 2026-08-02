import { afterEach, beforeEach } from "@std/testing/bdd";
import { type Spy, spy } from "@std/testing/mock";
import { useDebugLogSpy } from "./debug-log.ts";

/** Capture console.error (where logError routes) per test. */
export const useErrorLogSpy = (): (() => Spy) => {
  let errorSpy: Spy;
  beforeEach(() => {
    errorSpy = spy(console, "error");
  });
  afterEach(() => {
    errorSpy.restore();
  });
  return () => errorSpy;
};

/** Re-export the debug log spy so tests import one helper module. */
export { useDebugLogSpy };

/** True if any captured error log line includes `needle`. */
export const errorLogged = (spy: () => Spy, needle: string): boolean =>
  spy().calls.some((call) => String(call.args[0]).includes(needle));

/** True if any captured debug log line includes `needle`. */
export const debugLogged = (spy: () => Spy, needle: string): boolean =>
  spy().calls.some((call) => String(call.args[0]).includes(needle));
