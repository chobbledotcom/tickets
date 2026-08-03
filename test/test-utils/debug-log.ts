import { afterEach, beforeEach } from "@std/testing/bdd";
import { type Spy, spy } from "@std/testing/mock";
import { map } from "#fp";
import { setSuppressDebugLogs } from "#shared/log-settings.ts";

/** Return the first value from each captured debug call. */
export const debugMessages = (debugSpy: Spy): unknown[] =>
  map((call: Spy["calls"][number]) => call.args[0])(debugSpy.calls);

/** Capture debug output for each test and restore global logging afterwards. */
export const useDebugLogSpy = (): (() => Spy) => {
  let debugSpy: Spy;
  beforeEach(() => {
    setSuppressDebugLogs(false);
    debugSpy = spy(console, "debug");
  });
  afterEach(() => {
    debugSpy.restore();
    setSuppressDebugLogs(null);
  });
  return () => debugSpy;
};

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

const logLogged = (logSpy: () => Spy, needle: string): boolean =>
  logSpy().calls.some((call) => String(call.args[0]).includes(needle));

export const errorLogged = (logSpy: () => Spy, needle: string): boolean =>
  logLogged(logSpy, needle);

export const debugLogged = (logSpy: () => Spy, needle: string): boolean =>
  logLogged(logSpy, needle);
