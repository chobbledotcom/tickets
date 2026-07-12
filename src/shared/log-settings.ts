import { lazyRef } from "#fp";

/** A log flag that is normally read from a process env var, but can be forced
 * on or off per test worker to avoid racing on the shared env. A `null`
 * override means "read the env var"; a boolean override wins. */
export const makeSuppressibleLogFlag = (
  envName: string,
): {
  isSuppressed: () => boolean;
  setOverride: (value: boolean | null) => void;
} => {
  const [getOverride, setOverride] = lazyRef<boolean | null>(() => null);
  return {
    isSuppressed: () => {
      const override = getOverride();
      if (override !== null) return override;
      return !!Deno.env.get(envName);
    },
    setOverride,
  };
};

const debugLogFlag = makeSuppressibleLogFlag("TEST_SUPPRESS_DEBUG_LOGS");

/** Set module-level debug log suppression without racing on process env. */
export const setSuppressDebugLogs = (value: boolean | null): void =>
  debugLogFlag.setOverride(value);

/** Whether debug logging is disabled for this process or test worker. */
export const shouldSuppressDebugLogs = (): boolean =>
  debugLogFlag.isSuppressed();
