/** Shared types and helpers for wallet settings factories. */

import { lazyRef } from "#fp";

export type SnapFn = (key: string) => string;
export type EncryptedUpdateFn = (key: string) => (v: string) => Promise<void>;

/** Return type of createHostConfigOverride. */
// deno-lint-ignore no-explicit-any
export type HostConfigOverride<T = any> = ReturnType<
  typeof createHostConfigOverride<T>
>;

/**
 * Create a host-config override pair: a getter that falls back to env,
 * and test helpers to set/reset the override.
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
    setOverride: (v: T | null) => setOverride(v),
    resetOverride: () => setOverride(undefined),
  };
};

/**
 * Mixin shared wallet config resolution properties onto a target object.
 * Uses Object.defineProperties to preserve getter semantics (spread would
 * eagerly evaluate getters, breaking `this` references like `this.dbConfig`).
 *
 * The target must already define `dbConfig` as a getter.
 */
export const mixinWalletConfigResolution = <T>(
  target: Record<string, unknown>,
  hostOverride: HostConfigOverride<T>,
): void => {
  Object.defineProperties(target, {
    hostConfig: {
      get() {
        return hostOverride.getHostConfig();
      },
      enumerable: true,
    },
    config: {
      get() {
        return this.dbConfig ?? this.hostConfig;
      },
      enumerable: true,
    },
    hasConfig: {
      get() {
        return this.config !== null;
      },
      enumerable: true,
    },
    setHostConfigForTest: { value: hostOverride.setOverride, enumerable: true },
    resetHostConfig: { value: hostOverride.resetOverride, enumerable: true },
  });
};
