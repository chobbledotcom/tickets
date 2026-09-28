/**
 * Shared helpers for the renewal feature used by admin templates and routes.
 */

import type { BuiltSite } from "#db/built-sites/types.ts";
import { DAY_MS, nowMs } from "#shared/now.ts";

/** Is a built site provisioned for renewals? (has a renewal token index) */
export const isProvisioned = (site: BuiltSite): boolean =>
  site.renewalTokenIndex !== null && site.renewalTokenIndex !== "";

/** Did the site's renewal-URL push confirm? A deadline alone proves nothing:
 * an admin may pre-stock one without any token, and a reserved-but-unconfirmed
 * token must stay retryable. */
export const isRenewalUrlConfirmed = (site: BuiltSite): boolean =>
  site.renewalUrlConfirmed;

/** A reserved token whose renewal-URL push never confirmed: the site holds no
 * working renewal link yet, so provisioning must be retried, not assumed
 * done. */
export const isReservedRenewal = (site: BuiltSite): boolean =>
  isProvisioned(site) && !isRenewalUrlConfirmed(site);

/** Format a read_only_from ISO string for display in the admin UI */
export const formatDeadlineLabel = (iso: string, now = nowMs()): string => {
  if (!iso) return "never";
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return "never";
  const diffMs = parsed - now;
  const diffDays = Math.round(Math.abs(diffMs) / DAY_MS);
  if (diffDays === 0) return "today";
  if (diffMs < 0) return `expired ${diffDays} day(s) ago`;
  return `in ${diffDays} day(s)`;
};
