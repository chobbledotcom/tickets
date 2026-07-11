import { lazyRef } from "#fp";

const [getSuppressDebugOverride, setSuppressDebugOverride] = lazyRef<
  boolean | null
>(() => null);

/** Set module-level debug log suppression without racing on process env. */
export const setSuppressDebugLogs = (value: boolean | null): void => {
  setSuppressDebugOverride(value);
};

/** Whether debug logging is disabled for this process or test worker. */
export const shouldSuppressDebugLogs = (): boolean => {
  const override = getSuppressDebugOverride();
  if (override !== null) return override;
  return !!Deno.env.get("TEST_SUPPRESS_DEBUG_LOGS");
};
