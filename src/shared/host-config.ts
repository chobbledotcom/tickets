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
 * of it. An override of `null` means "the host has none", which is different
 * from having no override at all.
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
