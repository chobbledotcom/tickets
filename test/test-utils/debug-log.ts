import { afterEach, beforeEach } from "@std/testing/bdd";
import { type Spy, spy } from "@std/testing/mock";
import { setSuppressDebugLogs } from "#shared/log-settings.ts";

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
