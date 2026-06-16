/**
 * Shared "by listing type" filter used on the public listings page and the
 * admin attendees list: the filter values, the category a listing falls under,
 * and the rendered "Showing: All / Standard / …" bar. Keeping it in one place
 * lets both pages drive the same control with their own link targets.
 */

import type { ListingType } from "#shared/types.ts";

/** Filter values: "all" plus the three listing categories. */
export const LISTING_FILTERS = [
  "all",
  "standard",
  "daily",
  "purchase-only",
] as const;

export type ListingFilter = (typeof LISTING_FILTERS)[number];

const LISTING_FILTER_LABELS: Record<ListingFilter, string> = {
  all: "All",
  daily: "Daily",
  "purchase-only": "Purchase Only",
  standard: "Standard",
};

/** Human label for a filter value (e.g. for a "… for <Type>" heading). */
export const listingFilterLabel = (f: ListingFilter): string =>
  LISTING_FILTER_LABELS[f];

/** Type guard for a raw `?filter=`/`?type=` value. */
export const isListingFilter = (s: string | null): s is ListingFilter =>
  s !== null && (LISTING_FILTERS as readonly string[]).includes(s);

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
  const links = options
    .map((f) => {
      const label = LISTING_FILTER_LABELS[f];
      return f === active
        ? `<strong><u>${label}</u></strong>`
        : `<a href="${hrefFor(f)}">${label}</a>`;
    })
    .join(" / ");
  return `<p class="type-filter">Showing: ${links}</p>`;
};
