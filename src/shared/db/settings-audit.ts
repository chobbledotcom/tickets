/**
 * Dev and test only. A route that reads a setting it never declared in its
 * prefix bundle gets a default or stale value SILENTLY, which is the failure
 * mode the on-demand system trades for. This proves the bundles are honest: at
 * the end of each request it asserts reads ⊆ loaded.
 *
 * It is a strict no-op in production: the bookkeeping state is only allocated
 * while the audit is explicitly enabled (the test harness turns it on), so
 * `recordSettingRead` / `recordSettingsLoaded` see no state and return
 * immediately — the only hot-path cost is one branch per read.
 */

import { lazyRef } from "#fp";
import { type RequestSlot, requestSlot } from "#shared/request-context.ts";

export type AuditState = {
  /** Config keys read via the snapshot/raw cache this request. */
  read: Set<string>;
  /** Config keys declared (passed to loadKeys) or written this request. */
  loaded: Set<string>;
};

/** Off in production; the test harness turns it on. */
const [isAuditEnabled, setAuditEnabled] = lazyRef<boolean>(() => false);

/** Enable/disable the audit. Pass `null` to reset to the default (off). */
export const setSettingsAuditEnabled = (value: boolean | null): void =>
  setAuditEnabled(value);

const AUDIT_SLOT: RequestSlot<AuditState> = {
  fresh: () => ({ loaded: new Set(), read: new Set() }),
  read: (store) => store.settingsAudit,
  write: (store, state) => {
    store.settingsAudit = state;
  },
};

/** The live audit state, allocated on first record while the audit is on.
 * Undefined in production and outside a request, so recording is a no-op. */
const auditState = (): AuditState | undefined =>
  isAuditEnabled() ? requestSlot(AUDIT_SLOT) : undefined;

/** Run `use` with the active audit state. No state = nothing to record. */
const withAuditState = (use: (state: AuditState) => void): void => {
  const state = auditState();
  if (state) use(state);
};

/** Record a settings read (no-op outside an audit). */
export const recordSettingRead = (configKey: string): void => {
  auditState()?.read.add(configKey);
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
      `Settings read but not declared for "${routeLabel}": ${missing.join(
        ", ",
      )}. ` +
        "Add these keys to the route's prefix bundle in src/features/settings-bundles.ts " +
        "(PREFIX_SETTINGS), or to INFRA_SETTINGS if they are read on every request.",
    );
  });
