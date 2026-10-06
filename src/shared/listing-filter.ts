/**
 * Shared listing filters for the admin listings dashboard and the admin
 * attendees list. They cover the "by listing type" values and category, the
 * type bar, and the group filter. Keeping them in one place lets both pages
 * drive the same controls with their own link targets.
 */

/* jscpd:ignore-start -- imports */
import { t } from "#i18n";
import { escapeHtml } from "#jsx/escape-html.ts";
import { renderFilterBar } from "#shared/filter-bar.ts";
import type { LedgerScopeOption } from "#shared/ledger-scope.ts";
import { sortByName } from "#shared/name-order.ts";
import { parsePositiveInt } from "#shared/validation/number.ts";
import type { ListingType } from "#types";
/* jscpd:ignore-end */

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

/**
 * The chosen id, only when it names one of the offered options. An unknown,
 * deleted, or malformed value falls back to "no choice", the same fallback
 * every other filter control uses.
 */
export const readChosenId = (
  options: readonly { id: number }[],
  raw: string | null,
): number | null => {
  const id = raw === null ? null : parsePositiveInt(raw);
  if (id === null) return null;
  return options.some((option) => option.id === id) ? id : null;
};

/** Parse the ?group= filter from a request URL the way the pages read ?type=.
 * Shared by the listings index and its CSV export. */
export const groupIdFromRequest = (
  request: Request,
  groups: readonly LedgerScopeOption[],
): number | null =>
  readChosenId(groups, new URL(request.url).searchParams.get("group"));

/**
 * The listings two restrictions both keep. Either side can be open ("keep
 * every listing", null). Two open sides stay open. One chosen group with an
 * empty membership keeps nothing, so an empty group shows the usual empty
 * state.
 */
export const intersectListingIds = (
  chosen: number[] | null,
  memberIds: ReadonlySet<number> | null,
): number[] | null => {
  if (memberIds === null) return chosen;
  if (chosen === null) return [...memberIds];
  return chosen.filter((id) => memberIds.has(id));
};

/**
 * Render the "Group: All groups / <name> …" filter as the same plain
 * paragraph of links the type and attribute filters use. Only the groups the
 * site stores are offered, so an option never names a missing group. Group
 * names carry user input, so they are escaped like the attribute filter's
 * wording.
 */
export const renderGroupFilter = (
  activeGroupId: number | null,
  groups: readonly LedgerScopeOption[],
  hrefFor: (groupId: number | null) => string,
): string =>
  groups.length === 0
    ? ""
    : renderFilterBar(t("terms.group"), [
        {
          active: activeGroupId === null,
          href: hrefFor(null),
          label: t("listings_table.filter.all_groups"),
        },
        ...sortByName([...groups]).map((group) => ({
          active: group.id === activeGroupId,
          href: hrefFor(group.id),
          label: escapeHtml(group.name),
        })),
      ]);
