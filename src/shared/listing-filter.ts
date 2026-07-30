/**
 * Shared "by listing type" filter used on the admin listings dashboard and the
 * admin attendees list: the filter values, the category a listing falls under,
 * and the rendered "Showing: All / Standard / …" bar. Keeping it in one place
 * lets both pages drive the same control with their own link targets.
 */

import { t } from "#i18n";
import { renderFilterBar } from "#shared/filter-bar.ts";
import type { ListingType } from "#shared/types.ts";

/** Filter values: "all" plus the three listing categories. */
export const LISTING_FILTERS = [
  "all",
  "standard",
  "daily",
  "purchase-only",
] as const;

export type ListingFilter = (typeof LISTING_FILTERS)[number];

const LISTING_FILTER_LABEL_KEYS: Record<ListingFilter, string> = {
  all: "listings_table.filter.all",
  daily: "listings_table.filter.daily",
  "purchase-only": "listings_table.filter.purchase_only",
  standard: "listings_table.filter.standard",
};

/** Human label for a filter value (e.g. for a "… for <Type>" heading).
 * Resolved per call, so it reads the catalog once the catalog is loaded. */
export const listingFilterLabel = (f: ListingFilter): string =>
  t(LISTING_FILTER_LABEL_KEYS[f]);

/** Type guard for a raw `?filter=`/`?type=` value. */
export const isListingFilter = (s: string | null): s is ListingFilter =>
  s !== null && (LISTING_FILTERS as readonly string[]).includes(s);

/** Parse the ?type= listing-category filter from a request URL, defaulting to
 * "all". Shared by the dashboard, the listings CSV export, and the attendees
 * browser so they all read the same filter the same way. */
export const listingTypeFromRequest = (request: Request): ListingFilter => {
  const raw = new URL(request.url).searchParams.get("type");
  return isListingFilter(raw) ? raw : "all";
};

/** The category a listing falls under: purchase-only first, then its type. */
export const listingCategory = (listing: {
  purchase_only: boolean;
  listing_type: ListingType;
}): ListingFilter =>
  listing.purchase_only
    ? "purchase-only"
    : listing.listing_type === "daily"
      ? "daily"
      : "standard";

/**
 * Curried filter: keep only the listings whose category matches `type`. "all"
 * passes everything through. Shared by the dashboard listing table and the
 * listings CSV export so both narrow by type identically.
 */
export const filterListingsByType =
  (type: ListingFilter) =>
  <T extends { purchase_only: boolean; listing_type: ListingType }>(
    listings: readonly T[],
  ): T[] =>
    type === "all"
      ? [...listings]
      : listings.filter((l) => listingCategory(l) === type);

/**
 * Render the "Showing: All / Standard / …" filter as a plain paragraph of links.
 * Only the categories actually present are offered; the active one is bold +
 * underlined, the rest link via `hrefFor`.
 */
export const renderTypeFilter = (
  active: ListingFilter,
  categories: readonly ListingFilter[],
  hrefFor: (f: ListingFilter) => string,
): string => {
  const options: ListingFilter[] = [
    "all",
    ...LISTING_FILTERS.filter((f) => f !== "all" && categories.includes(f)),
  ];
  return renderFilterBar(
    "Showing",
    options.map((f) => ({
      active: f === active,
      href: hrefFor(f),
      label: listingFilterLabel(f),
    })),
  );
};
