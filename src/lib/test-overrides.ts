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