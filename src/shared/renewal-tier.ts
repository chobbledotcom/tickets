/** Which listings can sell renewal months. A tier listing qualifies when it
 *  is purchase-only, hidden, active, priced by the month, and not itself a
 *  site plan. A dual-role listing assigns a new site and extends a renewal. */

import { getAllListings } from "#db/listings/records.ts";
import { sort } from "#fp";

export type TierListing = Awaited<ReturnType<typeof getAllListings>>[number];
export type RenewalTierListing = Pick<
  TierListing,
  "active" | "assignBuiltSite" | "hidden" | "monthsPerUnit" | "purchaseOnly"
>;

export const isQualifyingTierListing = (listing: RenewalTierListing): boolean =>
  listing.purchaseOnly &&
  listing.hidden &&
  listing.monthsPerUnit > 0 &&
  listing.active &&
  !listing.assignBuiltSite;

/** All listings that qualify as renewal tiers. */
export const getQualifyingTierListings = async (): Promise<TierListing[]> => {
  const listings = await getAllListings();
  return listings.filter(isQualifyingTierListing);
};

/** Pick the cheapest qualifying tier listing. */
export const pickTierListing = async (): Promise<TierListing | null> => {
  const qualifying = await getQualifyingTierListings();
  if (qualifying.length === 0) return null;
  const sorted = sort(
    (a: (typeof qualifying)[number], b: (typeof qualifying)[number]) =>
      a.unitPrice - b.unitPrice,
  )(qualifying);
  return sorted[0]!;
};
