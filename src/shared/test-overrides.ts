import { lazyRef } from "#fp";
import { getEnv } from "#shared/env.ts";

const [getRethrowErrors, setRethrowErrors] = lazyRef<boolean | null>(
  () => null,
);

export { getRethrowErrors, setRethrowErrors };

const [getSkipLoginDelay, setSkipLoginDelay] = lazyRef(
  () => !!getEnv("TEST_SKIP_LOGIN_DELAY"),
);

export { getSkipLoginDelay, setSkipLoginDelay };

// Storage delete override for testing fire-and-forget error handling
const [getDeleteOverride, setDeleteOverride] = lazyRef<Error | null>(
  () => null,
);

export { getDeleteOverride, setDeleteOverride };

// API key touch override for testing fire-and-forget error handling
const [getTouchOverride, setTouchOverride] = lazyRef<Error | null>(() => null);

export { getTouchOverride, setTouchOverride };
