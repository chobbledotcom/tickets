/**
 * Dev and test only. A route that reads a setting it never declared in its
 * prefix bundle gets a default or stale value SILENTLY, which is the failure
 * mode the on-demand system trades for. This proves the bundles are honest: at
 * the end of each request it asserts reads ⊆ loaded.
 *
 * It is a strict no-op in production: `runWithSettingsAudit` only enters the
 * AsyncLocalStorage scope when explicitly enabled (the test harness turns it
 * on), so `recordSettingRead` / `recordSettingsLoaded` see no store and return
 * immediately — the only hot-path cost is one `getStore()` branch per read.
 */

import { lazyRef } from "#fp";
import { createScope } from "#shared/request-scoped.ts";

type AuditState = {
  /** Config keys read via the snapshot/raw cache this request. */
  read: Set<string>;
  /** Config keys declared (passed to loadKeys) or written this request. */
  loaded: Set<string>;
};

const auditScope = createScope<AuditState>();

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
    ? auditScope.run({ loaded: new Set(), read: new Set() }, fn)
    : fn();

/** Run `use` with the active audit state, if we are inside an audit scope.
 * Outside a scope there is no live store, so this does nothing. */
const withAuditState = (use: (state: AuditState) => void): void => {
  const state = auditScope.current();
  if (state) use(state);
};

/** Record a settings read (no-op outside an audit scope). */
export const recordSettingRead = (configKey: string): void => {
  auditScope.current()?.read.add(configKey);
};

/** Record keys made available this request — loaded or written (no-op outside). */
export const recordSettingsLoaded = (keys: Iterable<string>): void =>
  withAuditState((state) => {
    for (const key of keys) state.loaded.add(key);
  });

/**
 * Assert every key read this request was also loaded. Throws naming the route
 * and the offending keys so the fix (add to the prefix bundle, or INFRA if read
 * on every request) is obvious. No-op outside an audit scope.
 */
export const assertSettingsReadsDeclared = (routeLabel: string): void =>
  withAuditState((state) => {
    const missing = [...state.read].filter((key) => !state.loaded.has(key));
    if (missing.length === 0) return;
    throw new Error(
      `Settings read but not declared for "${routeLabel}": ${missing.join(", ")}. ` +
        "Add these keys to the route's prefix bundle in src/features/settings-bundles.ts " +
        "(PREFIX_SETTINGS), or to INFRA_SETTINGS if they are read on every request.",
    );
  });
