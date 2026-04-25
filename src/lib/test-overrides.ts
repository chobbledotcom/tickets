import { lazyRef } from "#fp";
import { getEnv } from "#lib/env.ts";

const [getRethrowErrors, setRethrowErrors] = lazyRef<boolean | null>(
  () => null,
);

export { getRethrowErrors, setRethrowErrors };

const [getSkipLoginDelay, setSkipLoginDelay] = lazyRef(
  () => !!getEnv("TEST_SKIP_LOGIN_DELAY"),
);

export { getSkipLoginDelay, setSkipLoginDelay };

export const setRethrowErrorsForTest = (rethrow: boolean | null): void =>
  setRethrowErrors(rethrow);

export const setSkipLoginDelayForTest = (skip: boolean): void =>
  setSkipLoginDelay(skip);

// Storage delete override for testing fire-and-forget error handling
const [getDeleteOverride, setDeleteOverride] = lazyRef<Error | null>(
  () => null,
);

export { getDeleteOverride, setDeleteOverride };

export const setDeleteOverrideForTest = (err: Error | null): void =>
  setDeleteOverride(err);

// API key touch override for testing fire-and-forget error handling
const [getTouchOverride, setTouchOverride] = lazyRef<Error | null>(() => null);

export { getTouchOverride, setTouchOverride };

export const setTouchOverrideForTest = (err: Error | null): void =>
  setTouchOverride(err);
