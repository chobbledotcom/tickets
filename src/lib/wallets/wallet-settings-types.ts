/** Shared types and helpers for wallet settings factories. */

import { lazyRef } from "#fp";
import { getEnv } from "#lib/env.ts";

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

/** Per-field key mapping: camelCase property → DB key + env var name */
export type WalletFieldDef = { dbKey: string; envKey: string };

export type WalletReadSettings<T, K extends string> = Record<K, string> & {
  hasDbConfig: boolean;
  dbConfig: T | null;
  hostConfig: T | null;
  config: T | null;
  hasConfig: boolean;
  setHostConfigForTest: (c: T | null) => void;
  resetHostConfig: () => void;
};

/**
 * Build a complete wallet settings kit from a field map and a builder.
 *
 * Returns:
 *   - getHostConfig: reads env vars (with test override support)
 *   - createReadSettings(snap): per-field getters + hasDbConfig/dbConfig +
 *     mixed-in hostConfig/config/hasConfig
 *   - createUpdateSettings(encryptedUpdate): per-field encrypted writers
 */
export const createWalletSettingsKit = <T, K extends string>(opts: {
  fields: Record<K, WalletFieldDef>;
  build: (vals: Record<K, string | undefined>) => T | null;
}) => {
  const keys = Object.keys(opts.fields) as K[];

  const hostOverride = createHostConfigOverride<T>(() => {
    const vals = {} as Record<K, string | undefined>;
    for (const k of keys) vals[k] = getEnv(opts.fields[k].envKey);
    return opts.build(vals);
  });

  const createReadSettings = (snap: SnapFn): WalletReadSettings<T, K> => {
    const obj = {} as Record<string, unknown>;
    for (const k of keys) {
      Object.defineProperty(obj, k, {
        get: () => snap(opts.fields[k].dbKey),
        enumerable: true,
      });
    }
    Object.defineProperties(obj, {
      hasDbConfig: {
        get(): boolean {
          return keys.every((k) => Boolean(this[k]));
        },
        enumerable: true,
      },
      dbConfig: {
        get(): T | null {
          const vals = {} as Record<K, string>;
          for (const k of keys) vals[k] = this[k] as string;
          return opts.build(vals);
        },
        enumerable: true,
      },
    });
    mixinWalletConfigResolution<T>(obj, hostOverride);
    return obj as WalletReadSettings<T, K>;
  };

  const createUpdateSettings = (
    encryptedUpdate: EncryptedUpdateFn,
  ): Record<K, (v: string) => Promise<void>> => {
    const obj = {} as Record<K, (v: string) => Promise<void>>;
    for (const k of keys) obj[k] = encryptedUpdate(opts.fields[k].dbKey);
    return obj;
  };

  return {
    getHostConfig: hostOverride.getHostConfig,
    createReadSettings,
    createUpdateSettings,
  };
};
