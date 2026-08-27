/**
 * A setting the host machine provides through its environment, with the hook a
 * test uses to stand a different value in front of it.
 */

import { lazyRef } from "#fp";

/** What {@link createHostConfigOverride} gives back. */
// deno-lint-ignore no-explicit-any
export type HostConfigOverride<T = any> = ReturnType<
  typeof createHostConfigOverride<T>
>;

/**
 * Read a host setting out of the environment, unless a test put one in front
 * of it. `setOverride(null)` clears the override rather than storing an empty
 * one, because that is what `lazyRef` does with null — so a test cannot say
 * "the host has none" over an environment that provides one.
 */
export const createHostConfigOverride = <T>(getFromEnv: () => T | null) => {
  const [getOverride, setOverride] = lazyRef<T | null | undefined>(
    () => undefined,
  );
  return {
    getHostConfig: () => {
      const o = getOverride();
      return o !== undefined ? o : getFromEnv();
    },
    resetOverride: () => setOverride(undefined),
    setOverride: (v: T | null) => setOverride(v),
  };
};
