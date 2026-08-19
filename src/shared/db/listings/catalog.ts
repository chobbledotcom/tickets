/** Narrow listing reads for catalogs and site-page pickers. */

import { settings } from "#db/settings.ts";
import { notInSubquery } from "#db/where-clauses.ts";
import type { CatalogSourceListing } from "#shared/external-order.ts";
import type { Listing } from "#types";
import { rawListingsTable } from "./table.ts";

export type ListingOfferFlags = Pick<
  Listing,
  "active" | "hidden" | "months_per_unit" | "purchase_only"
>;

type ListingPickerRow = ListingOfferFlags & { name: string };

const listingOfferFlagsColumns = rawListingsTable.read.pick([
  "active",
  "hidden",
  "months_per_unit",
  "purchase_only",
]);

const listingPickerColumns = rawListingsTable.read.pick([
  "id",
  "name",
  ...listingOfferFlagsColumns.columns,
]);

const catalogListingColumns = rawListingsTable.read.pick([
  "id",
  "slug",
  "name",
  "unit_price",
  "listing_type",
  "customisable_days",
  "can_pay_more",
]);

/** Read the flags that decide whether one listing may be offered. */
export const getListingOfferFlags = async (
  id: number,
): Promise<ListingOfferFlags | undefined> => {
  const row = await listingOfferFlagsColumns.one({ id }, { alias: "listing" });
  return row ?? undefined;
};

/** Read names and offer flags for the admin site-page picker. */
export const getListingPickerNames = async (): Promise<
  Map<number, ListingPickerRow>
> => {
  const rows = await listingPickerColumns.many(
    {},
    { alias: "listing", order: "listing.id ASC" },
  );
  return new Map(rows.map(({ id, ...listing }) => [id, listing] as const));
};

const catalogVisibleSql = (hiddenDefault: boolean | undefined): string => {
  const inheriting =
    "(listing.use_defaults = 1 AND listing.months_per_unit = 0)";
  if (hiddenDefault === undefined) return "listing.hidden = 0";
  return hiddenDefault
    ? `listing.hidden = 0 AND NOT ${inheriting}`
    : `(${inheriting} OR listing.hidden = 0)`;
};

/** Read only active, effectively visible listings for the public catalog. */
export const getCatalogListings = async (): Promise<CatalogSourceListing[]> => {
  const rows = await catalogListingColumns.many(
    {},
    {
      alias: "listing",
      where: [
        { args: [], clause: "listing.active = 1" },
        {
          args: [],
          clause: catalogVisibleSql(settings.listingDefaults.hidden),
        },
        // A child listing is only offered on its own when it says it may be.
        {
          args: [],
          clause: `(listing.bookable_alone = 1 OR listing.id NOT IN (
          SELECT listingParent.child_listing_id FROM listing_parents AS listingParent))`,
        },
        ...notInSubquery("listing.id", {
          args: [],
          sql: `SELECT groupListing.listing_id
                FROM group_listings AS groupListing
                JOIN groups AS listingGroup ON listingGroup.id = groupListing.group_id
               WHERE listingGroup.is_package = 1
                 AND listingGroup.hide_package_listings = 1`,
        }),
      ],
    },
  );
  return rows.map((row) => ({
    active: true,
    hidden: false,
    ...row,
  }));
};
