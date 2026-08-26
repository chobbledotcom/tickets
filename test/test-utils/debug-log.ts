import { afterEach, beforeEach } from "@std/testing/bdd";
import type { Spy } from "@std/testing/mock";
import { map } from "#fp";
import { setSuppressDebugLogs } from "#shared/log-settings.ts";
import { useConsoleSpy } from "#test-utils/error-spy.ts";

/** Return the first value from each captured debug call. */
export const debugMessages = (debugSpy: Spy): unknown[] =>
  map((call: Spy["calls"][number]) => call.args[0])(debugSpy.calls);

/** Capture debug output for each test and restore global logging afterwards. */
export const useDebugLogSpy = (): (() => Spy) => {
  beforeEach(() => setSuppressDebugLogs(false));
  afterEach(() => setSuppressDebugLogs(null));
  return useConsoleSpy("debug");
};

/** Capture console.error (where logError routes) per test. */
export const useErrorLogSpy = (): (() => Spy) => useConsoleSpy("error");

const logLogged = (logSpy: () => Spy, needle: string): boolean =>
  logSpy().calls.some((call) => String(call.args[0]).includes(needle));

export const errorLogged = (logSpy: () => Spy, needle: string): boolean =>
  logLogged(logSpy, needle);

export const debugLogged = (logSpy: () => Spy, needle: string): boolean =>
  logLogged(logSpy, needle);
