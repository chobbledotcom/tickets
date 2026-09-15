/** Which listings can sell renewal months. A tier listing qualifies when it is
 *  purchase-only, hidden, active, priced by the month, and not itself a site
 *  plan — a dual-role listing would assign a new site and extend a renewal. */

import { getAllListings } from "#db/listings/records.ts";
import { sort } from "#fp";

export type TierListing = Awaited<ReturnType<typeof getAllListings>>[number];
export type RenewalTierListing = Pick<
  TierListing,
  | "active"
  | "assign_built_site"
  | "hidden"
  | "months_per_unit"
  | "purchase_only"
>;

export const isQualifyingTierListing = (listing: RenewalTierListing): boolean =>
  listing.purchase_only &&
  listing.hidden &&
  listing.months_per_unit > 0 &&
  listing.active &&
  !listing.assign_built_site;

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
      a.unit_price - b.unit_price,
  )(qualifying);
  return sorted[0]!;
};
