/** Narrow listing reads for catalogs and site-page pickers. */

import { decrypt } from "#shared/crypto/encryption.ts";
import type { EnvKeyEncrypted } from "#shared/crypto/sealed.ts";
import { queryAll, queryOne } from "#shared/db/client.ts";
import { decryptNameSlug } from "#shared/db/query.ts";
import { settings } from "#shared/db/settings.ts";
import type { CatalogSourceListing } from "#shared/external-order.ts";
import type { Listing } from "#shared/types.ts";

export type ListingOfferFlags = Pick<
  Listing,
  "active" | "hidden" | "months_per_unit" | "purchase_only"
>;

type ListingPickerRow = ListingOfferFlags & { name: string };

type RawOfferFlagRow = {
  active: number;
  hidden: number;
  months_per_unit: number;
  purchase_only: number;
};

const OFFER_FLAG_COLUMNS =
  "listing.active, listing.hidden, listing.months_per_unit, listing.purchase_only";

const offerFlagsOf = (row: RawOfferFlagRow): ListingOfferFlags => ({
  active: row.active !== 0,
  hidden: row.hidden !== 0,
  months_per_unit: row.months_per_unit,
  purchase_only: row.purchase_only !== 0,
});

/** Read the flags that decide whether one listing may be offered. */
export const getListingOfferFlags = async (
  id: number,
): Promise<ListingOfferFlags | undefined> => {
  const row = await queryOne<RawOfferFlagRow>(
    `SELECT ${OFFER_FLAG_COLUMNS} FROM listings AS listing WHERE listing.id = ? LIMIT 1`,
    [id],
  );
  return row ? offerFlagsOf(row) : undefined;
};

/** Read names and offer flags for the admin site-page picker. */
export const getListingPickerNames = async (): Promise<
  Map<number, ListingPickerRow>
> => {
  const rows = await queryAll<
    RawOfferFlagRow & { id: number; name: EnvKeyEncrypted }
  >(
    `SELECT listing.id, listing.name, ${OFFER_FLAG_COLUMNS} FROM listings AS listing ORDER BY listing.id ASC`,
  );
  const entries = await Promise.all(
    rows.map(
      async (row) =>
        [
          row.id,
          { ...offerFlagsOf(row), name: await decrypt(row.name) },
        ] as const,
    ),
  );
  return new Map(entries);
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
  type CatalogRow = Omit<
    CatalogSourceListing,
    "active" | "hidden" | "customisable_days" | "can_pay_more" | "name" | "slug"
  > & {
    customisable_days: number;
    can_pay_more: number;
    name: EnvKeyEncrypted;
    slug: EnvKeyEncrypted;
  };
  const rows = await queryAll<CatalogRow>(
    `SELECT listing.id, listing.slug, listing.name, listing.unit_price,
            listing.listing_type, listing.customisable_days, listing.can_pay_more
     FROM listings AS listing
     WHERE listing.active = 1
       AND ${catalogVisibleSql(settings.listingDefaults.hidden)}
       AND (listing.bookable_alone = 1
            OR listing.id NOT IN (
              SELECT listingParent.child_listing_id
              FROM listing_parents AS listingParent
            ))
       AND listing.id NOT IN (
         SELECT groupListing.listing_id
           FROM group_listings AS groupListing
           JOIN groups AS listingGroup ON listingGroup.id = groupListing.group_id
          WHERE listingGroup.is_package = 1
            AND listingGroup.hide_package_listings = 1
       )`,
  );
  return Promise.all(
    rows.map(async (row) => ({
      active: true,
      can_pay_more: row.can_pay_more === 1,
      customisable_days: row.customisable_days === 1,
      hidden: false,
      id: row.id,
      listing_type: row.listing_type,
      ...(await decryptNameSlug(row, decrypt)),
      unit_price: row.unit_price,
    })),
  );
};
