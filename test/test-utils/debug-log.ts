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
