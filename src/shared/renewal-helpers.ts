/**
 * Shared helpers for the renewal feature used by admin templates and routes.
 */

import type { BuiltSite } from "#shared/db/built-sites.ts";
import { nowMs } from "#shared/now.ts";

/** Is a built site provisioned for renewals? (has both token index and tier event) */
export const isProvisioned = (site: BuiltSite): boolean =>
  site.renewalTokenIndex !== null && site.renewalTierEventId !== null;

/** Format a read_only_from ISO string for display in the admin UI */
export const formatDeadlineLabel = (iso: string, now = nowMs()): string => {
  if (!iso) return "never";
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return "never";
  const diffMs = parsed - now;
  const diffDays = Math.round(Math.abs(diffMs) / 86_400_000);
  if (diffDays === 0) return "today";
  if (diffMs < 0) return `expired ${diffDays} day(s) ago`;
  return `in ${diffDays} day(s)`;
};
