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
    resetOverride: () => setOverride(undefined),
    setOverride: (v: T | null) => setOverride(v),
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
    config: {
      enumerable: true,
      get() {
        return this.dbConfig ?? this.hostConfig;
      },
    },
    hasConfig: {
      enumerable: true,
      get() {
        return this.config !== null;
      },
    },
    hostConfig: {
      enumerable: true,
      get() {
        return hostOverride.getHostConfig();
      },
    },
    resetHostConfig: { enumerable: true, value: hostOverride.resetOverride },
    setHostConfigForTest: { enumerable: true, value: hostOverride.setOverride },
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
        enumerable: true,
        get: () => snap(opts.fields[k].dbKey),
      });
    }
    Object.defineProperties(obj, {
      dbConfig: {
        enumerable: true,
        get(): T | null {
          const vals = {} as Record<K, string>;
          for (const k of keys) vals[k] = this[k] as string;
          return opts.build(vals);
        },
      },
      hasDbConfig: {
        enumerable: true,
        get(): boolean {
          return keys.every((k) => Boolean(this[k]));
        },
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
    createReadSettings,
    createUpdateSettings,
    getHostConfig: hostOverride.getHostConfig,
  };
};
