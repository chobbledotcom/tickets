/** Narrow listing reads for catalogs and site-page pickers. */

import { LISTING_ROW } from "#db/listings/select.ts";
import { LISTINGS_IN_ID_ORDER } from "#db/listings/table.ts";
import {
  and,
  type Expr,
  equal,
  literal,
  not,
  notInQuery,
  or,
} from "#db/select/expression.ts";
import { from } from "#db/select/query.ts";
import { tables } from "#db/select/tables.ts";
import { settings } from "#db/settings.ts";
import type { CatalogSourceListing } from "#shared/external-order.ts";
import type { Listing } from "#types";
import { rawListingsTable } from "./table.ts";

export type ListingOfferFlags = Pick<
  Listing,
  | "active"
  | "assign_built_site"
  | "hidden"
  | "months_per_unit"
  | "purchase_only"
>;

type ListingPickerRow = ListingOfferFlags & { name: string };

const listingOfferFlagsColumns = rawListingsTable.read.pick([
  "active",
  "assign_built_site",
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

/** Read the flags that decide whether one listing can be offered. */
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
  const rows = await listingPickerColumns.many({}, LISTINGS_IN_ID_ORDER);
  return new Map(rows.map(({ id, ...listing }) => [id, listing] as const));
};

const catalogVisible = (hiddenDefault: boolean | undefined): Expr<boolean> => {
  const shown = equal(LISTING_ROW.hidden, literal(0));
  if (hiddenDefault === undefined) return shown;
  const inheriting = and(
    equal(LISTING_ROW.use_defaults, literal(1)),
    equal(LISTING_ROW.months_per_unit, literal(0)),
  );
  return hiddenDefault ? and(shown, not(inheriting)) : or(inheriting, shown);
};

/** Read only active, effectively visible listings for the public catalog. */
export const getCatalogListings = async (): Promise<CatalogSourceListing[]> => {
  const rows = await catalogListingColumns.many(
    {},
    {
      alias: "listing",
      where: [
        equal(LISTING_ROW.active, literal(1)),
        // A built-site plan is booked on its own checkout page, so the external
        // order widget — which cannot carry the site-setup flow — never lists it.
        equal(LISTING_ROW.assign_built_site, literal(0)),
        catalogVisible(settings.listingDefaults.hidden),
        // A child listing is only offered on its own when it says it can be.
        or(
          equal(LISTING_ROW.bookable_alone, literal(1)),
          notInQuery(
            LISTING_ROW.id,
            from(tables.listing_parents).values(
              (edge) => edge.child_listing_id,
            ),
          ),
        ),
      ],
    },
  );
  return rows.map((row) => ({
    active: true,
    hidden: false,
    ...row,
  }));
};
