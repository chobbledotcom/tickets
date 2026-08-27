/**
 * A setting the host machine provides through its environment, with the hook a
 * test uses to stand a different value in front of it.
 */

import { lazyRef } from "#fp";

/**
 * What {@link createHostConfigOverride} gives back: the reader every caller
 * uses, and the two hooks a test drives it with.
 */
export interface HostConfigOverride<T> {
  getHostConfig: () => T | null;
  resetOverride: () => void;
  setOverride: (value: T | null) => void;
}

/**
 * Read a host setting out of the environment, unless a test put one in front
 * of it. `setOverride(null)` clears the override rather than storing an empty
 * one, because that is what `lazyRef` does with null — so a test cannot say
 * "the host has none" over an environment that provides one.
 */
export const createHostConfigOverride = <T>(
  getFromEnv: () => T | null,
): HostConfigOverride<T> => {
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
