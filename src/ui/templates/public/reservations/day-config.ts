import {
  dayCountsEveryListingSupports,
  keepParentDayCountsChildrenSupport,
  packageDayCountsChildrenSupport,
  type TicketListing,
} from "#shared/booking/model.ts";
import { packageBundleTotal } from "#shared/booking/price-tree.ts";
import type { BookingTree } from "#shared/booking/tree.ts";
import { dayPriceFor, type ListingWithCount } from "#shared/types.ts";

/** On a customisable PACKAGE page, one whole bundle's price for a given day
 * count: each member node's effective per-unit price for that span (its flat
 * package override, else its per-day package override, else its own entered day
 * price — never base × days) plus its minimum unavoidable child charge, times
 * its fixed per-package quantity. Walks the canonical tree so the selector's
 * labels can't drift from what the checkout charges. `customPrices` is empty:
 * pay-more listings can't join a package. */
const packageDayCountPriceFor =
  (tree: BookingTree, bookableChildren: ReadonlySet<number>) =>
  (days: number): number =>
    packageBundleTotal(tree, days, bookableChildren);

/** The day-count option pricer for a page: a page that IS one customisable
 * package prices each option as the whole bundle's total; every other page
 * keeps the pricer {@link dayConfig} resolved (the single listing's own day
 * prices, or none). */
export const resolveDayCountPriceFor = (
  singlePackagePage: boolean,
  tree: BookingTree,
  bookableChildren: ReadonlySet<number>,
  dayCfg: {
    hasCustomisable: boolean;
    dayCountPriceFor?: ((days: number) => number | null) | undefined;
  },
): ((days: number) => number | null) | undefined =>
  singlePackagePage && dayCfg.hasCustomisable
    ? packageDayCountPriceFor(tree, bookableChildren)
    : dayCfg.dayCountPriceFor;

/**
 * Day-selection config for the booking form, derived from the page's listings.
 * Customisable-days listings drive a shared "number of days" selector; on a
 * single-listing page each option carries its price, and the date selector's
 * duration label is suppressed (the span is chosen, not fixed).
 */
export const dayConfig = (
  listings: TicketListing[],
  singleListing: ListingWithCount | null,
  childrenByParentId: Map<number, TicketListing[]> | undefined,
  hasPackages: boolean,
): {
  hasCustomisable: boolean;
  dayCounts: number[];
  dayCountPriceFor?: ((days: number) => number | null) | undefined;
  dateDurationDays: number;
} => ({
  dateDurationDays:
    singleListing && !singleListing.customisable_days
      ? singleListing.duration_days
      : 1,
  dayCountPriceFor: singleListing?.customisable_days
    ? (days: number) => dayPriceFor(singleListing, days)
    : undefined,
  // A package books every member, so each parent member's child union
  // constrains the bundle's spans; other pages constrain only the
  // single-listing-parent case.
  dayCounts:
    hasPackages && childrenByParentId
      ? packageDayCountsChildrenSupport(listings, childrenByParentId)
      : keepParentDayCountsChildrenSupport(
          listings,
          dayCountsEveryListingSupports(listings),
          childrenByParentId,
        ),
  hasCustomisable: listings.some((e) => e.listing.customisable_days),
});
