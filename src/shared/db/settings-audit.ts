/**
 * Dev/test-only safety net for the keyed settings pre-load (settings-plan.md §2c).
 *
 * A route that reads a setting it never declared in its prefix bundle gets a
 * default/stale value silently — the failure mode the on-demand system trades
 * for. This module proves bundles are honest: every settings read during a
 * request is recorded, every key passed to `loadKeys` (or written) is recorded
 * as "loaded", and at the end of the request we assert reads ⊆ loaded.
 *
 * It is a strict no-op in production: `runWithSettingsAudit` only enters the
 * AsyncLocalStorage scope when explicitly enabled (the test harness turns it
 * on), so `recordSettingRead` / `recordSettingsLoaded` see no store and return
 * immediately — the only hot-path cost is one `getStore()` branch per read.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { lazyRef } from "#fp";

type AuditState = {
  /** Config keys read via the snapshot/raw cache this request. */
  read: Set<string>;
  /** Config keys declared (passed to loadKeys) or written this request. */
  loaded: Set<string>;
};

const store = new AsyncLocalStorage<AuditState>();

/** Off in production; the test harness turns it on. */
const [isAuditEnabled, setAuditEnabled] = lazyRef<boolean>(() => false);

/** Enable/disable the audit. Pass `null` to reset to the default (off). */
export const setSettingsAuditEnabled = (value: boolean | null): void =>
  setAuditEnabled(value);

/**
 * Run `fn` within an audit scope when enabled, else pass straight through so
 * production never pays for the AsyncLocalStorage frame or the bookkeeping.
 */
export const runWithSettingsAudit = <T>(fn: () => T): T =>
  isAuditEnabled()
    ? store.run({ loaded: new Set(), read: new Set() }, fn)
    : fn();

/** Record a settings read (no-op outside an audit scope). */
export const recordSettingRead = (configKey: string): void => {
  store.getStore()?.read.add(configKey);
};

/** Record keys made available this request — loaded or written (no-op outside). */
export const recordSettingsLoaded = (keys: Iterable<string>): void => {
  const state = store.getStore();
  if (!state) return;
  for (const key of keys) state.loaded.add(key);
};

/**
 * Assert every key read this request was also loaded. Throws naming the route
 * and the offending keys so the fix (add to the prefix bundle, or INFRA if read
 * on every request) is obvious. No-op outside an audit scope.
 */
export const assertSettingsReadsDeclared = (routeLabel: string): void => {
  const state = store.getStore();
  if (!state) return;
  const missing = [...state.read].filter((key) => !state.loaded.has(key));
  if (missing.length === 0) return;
  throw new Error(
    `Settings read but not declared for "${routeLabel}": ${missing.join(", ")}. ` +
      "Add these keys to the route's prefix bundle in src/features/index.ts " +
      "(PREFIX_SETTINGS), or to INFRA_SETTINGS if they are read on every request.",
  );
};
