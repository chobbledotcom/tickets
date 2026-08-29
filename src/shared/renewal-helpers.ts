/**
 * Shared helpers for the renewal feature used by admin templates and routes.
 */

import type { BuiltSite } from "#db/built-sites/types.ts";
import { DAY_MS, nowMs } from "#shared/now.ts";

/** Is a built site provisioned for renewals? (has a renewal token index) */
export const isProvisioned = (site: BuiltSite): boolean =>
  site.renewalTokenIndex !== null && site.renewalTokenIndex !== "";

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

/** The little a tier needs for a site to renew on it. */
type RenewableTier = { id: number };

/** Which renewal tier a site is on, and what its renewal page offers.
 * `retired` is a tier an operator chose that no longer qualifies — its listing
 * was deleted, deactivated, unhidden, or lost its months per unit. */
export type SiteRenewalTier<Tier extends RenewableTier> = {
  /** A site on one tier offers only that tier. Every other site offers all of
   * them, so a retired tier never leaves a customer with nothing to buy. */
  offered: Tier[];
} & (
  | { kind: "any" }
  | { kind: "pinned"; tier: Tier }
  | { kind: "retired"; listingId: number }
);

export const siteRenewalTier = <Tier extends RenewableTier>(
  site: Pick<BuiltSite, "renewalTierListingId">,
  qualifying: readonly Tier[],
): SiteRenewalTier<Tier> => {
  const everyTier = [...qualifying];
  const chosenId = site.renewalTierListingId;
  if (chosenId === null) return { kind: "any", offered: everyTier };
  const tier = qualifying.find((candidate) => candidate.id === chosenId);
  return tier
    ? { kind: "pinned", offered: [tier], tier }
    : { kind: "retired", listingId: chosenId, offered: everyTier };
};
