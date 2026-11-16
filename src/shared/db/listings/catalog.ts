/** Narrow listing reads for catalogs and site-page pickers. */

import { LISTING_ROW } from "#db/listings/select.ts";
import { readOneRow, readRows } from "#db/read.ts";
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
import { type DecodedRowOf, tables } from "#db/select/tables.ts";
import { settings } from "#db/settings.ts";
import type { CatalogSourceListing } from "#shared/external-order.ts";
import type { Listing } from "#types";

/** The narrow listing shape used by listing and attribute pickers. */
export type ListingOption = Pick<
  DecodedRowOf<"listings">,
  "active" | "id" | "name"
>;

export type ListingOfferFlags = Pick<
  Listing,
  "active" | "assignBuiltSite" | "hidden" | "monthsPerUnit" | "purchaseOnly"
>;

type ListingPickerRow = ListingOfferFlags & { name: string };

/** The columns that decide whether one listing can be offered. */
const OFFER_FLAG_COLUMNS = [
  "active",
  "assignBuiltSite",
  "hidden",
  "monthsPerUnit",
  "purchaseOnly",
] as const;

/** Every listing in id order. */
const listingsInIdOrder = from(tables.listings).sortedBy("id");

/** Read the id, name and active flag of every listing, for item pickers. */
export const getAllListingOptions = (): Promise<ListingOption[]> =>
  readRows(listingsInIdOrder.pick("id", "name", "active"));

/** Read the flags that decide whether one listing can be offered. */
export const getListingOfferFlags = async (
  id: number,
): Promise<ListingOfferFlags | undefined> => {
  const row = await readOneRow(
    from(tables.listings)
      .where({ id })
      .pick(...OFFER_FLAG_COLUMNS),
  );
  return row ?? undefined;
};

/** Read names and offer flags for the admin site-page picker. */
export const getListingPickerNames = async (): Promise<
  Map<number, ListingPickerRow>
> => {
  const rows = await readRows(
    listingsInIdOrder.pick("id", "name", ...OFFER_FLAG_COLUMNS),
  );
  return new Map(rows.map(({ id, ...listing }) => [id, listing] as const));
};

const catalogVisible = (hiddenDefault: boolean | undefined): Expr<boolean> => {
  const shown = equal(LISTING_ROW.hidden, literal(0));
  if (hiddenDefault === undefined) return shown;
  const inheriting = and(
    equal(LISTING_ROW.useDefaults, literal(1)),
    equal(LISTING_ROW.monthsPerUnit, literal(0)),
  );
  return hiddenDefault ? and(shown, not(inheriting)) : or(inheriting, shown);
};

/** Read only active, effectively visible listings for the public catalog. */
export const getCatalogListings = async (): Promise<CatalogSourceListing[]> => {
  const rows = await readRows(
    from(tables.listings)
      .where(() => [
        equal(LISTING_ROW.active, literal(1)),
        // A built-site plan is booked on its own checkout page, so the external
        // order widget — which cannot carry the site-setup flow — never lists it.
        equal(LISTING_ROW.assignBuiltSite, literal(0)),
        catalogVisible(settings.listingDefaults.hidden),
        // A child listing is only offered on its own when it says it can be.
        or(
          equal(LISTING_ROW.bookableAlone, literal(1)),
          notInQuery(
            LISTING_ROW.id,
            from(tables.listing_parents).values((edge) => edge.childListingId),
          ),
        ),
      ])
      .pick(
        "id",
        "slug",
        "name",
        "unitPrice",
        "listingType",
        "customisableDays",
        "canPayMore",
      ),
  );
  return rows.map((row) => ({
    active: true,
    hidden: false,
    ...row,
  }));
};
