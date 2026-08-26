/**
 * Group-membership helpers used only by catalog import/export, kept out of
 * `#db/groups.ts` so the transfer feature owns its own plumbing.
 *
 * The writes batch into at most two multi-row INSERTs. A statement per member
 * passes {@link TRANSACTION_ROUNDTRIP_THRESHOLD} on a ~30-member export.
 */

import type { InValue } from "@libsql/client";
import {
  inPlaceholders,
  queryAll,
  type SqlStatement,
  type TxScope,
} from "#db/client.ts";
import { PRICE_TYPE_GROUP, PRICE_TYPE_GROUP_DAY } from "#db/listing-prices.ts";
import { type DayPrices, type GroupListing, parseDayPrices } from "#types";

/** Every group a listing belongs to, with this listing's per-package override
 * and quantity — the membership facet a catalog export captures for one listing.
 * A `null` `package_price` means "no override"; `quantity` defaults to 1. The
 * flat override lives in the `group` dimension of `listing_prices` (the
 * `group_listings.package_price` column was retired), read back by subquery. */
export const getListingGroupMemberships = (
  listingId: number,
): Promise<GroupListing[]> =>
  queryAll<GroupListing>(
    `SELECT groupListing.group_id, groupListing.listing_id, groupListing.quantity,
            (SELECT listingPrice.unit_price FROM listing_prices AS listingPrice
               WHERE listingPrice.listing_id = groupListing.listing_id
                 AND listingPrice.price_type = '${PRICE_TYPE_GROUP}'
                 AND listingPrice.price_id = CAST(groupListing.group_id AS TEXT))
              AS package_price
       FROM group_listings AS groupListing
      WHERE groupListing.listing_id = ? ORDER BY groupListing.group_id ASC`,
    [listingId],
  );

/** One membership to (re)create on catalog import: which listing joins which
 * group, with its package override, quantity, and per-day overrides. */
export type ImportedMembership = {
  groupId: number;
  listingId: number;
  packagePrice: number | null;
  quantity: number;
  dayPrices: DayPrices;
};

/** Build a multi-row INSERT for `table(columns)` from `rows`, or null when there
 * are no rows. Each row supplies one value per column, in order. */
const multiRowInsert = (
  table: string,
  columns: readonly string[],
  rows: readonly InValue[][],
): SqlStatement | null => {
  if (rows.length === 0) return null;
  const placeholder = `(${inPlaceholders(columns)})`;
  return {
    args: rows.flat(),
    sql: `INSERT INTO ${table} (${columns.join(", ")}) VALUES ${rows
      .map(() => placeholder)
      .join(", ")}`,
  };
};

/** The (at most two) batched statements that create every membership row plus
 * its price overrides. The `group_listings` row carries only membership +
 * `quantity`; the flat package override and each per-day override are `group` /
 * `group_day` rows in `listing_prices` (the `group_listings.package_price` column
 * was retired). Targeted inserts (no group-wide delete), so importing into an
 * already-populated package never disturbs its other members. */
export const membershipStatements = (
  memberships: readonly ImportedMembership[],
): SqlStatement[] => {
  const memberRows = memberships.map((m) => [
    m.groupId,
    m.listingId,
    m.quantity,
  ]);
  // A `null` package price means "no override" — write no `group` row for it.
  const flatRows = memberships.flatMap((m) =>
    m.packagePrice === null
      ? []
      : [[m.listingId, PRICE_TYPE_GROUP, String(m.groupId), m.packagePrice]],
  );
  const dayRows = memberships.flatMap((m) =>
    Object.entries(parseDayPrices(m.dayPrices)).map(([days, price]) => [
      m.listingId,
      PRICE_TYPE_GROUP_DAY,
      `${m.groupId}/${days}`,
      price,
    ]),
  );
  return [
    multiRowInsert(
      "group_listings",
      ["group_id", "listing_id", "quantity"],
      memberRows,
    ),
    multiRowInsert(
      "listing_prices",
      ["listing_id", "price_type", "price_id", "unit_price"],
      [...flatRows, ...dayRows],
    ),
  ].filter((stmt): stmt is SqlStatement => stmt !== null);
};

/** Write every membership (batched) inside an existing write transaction — the
 * catalog-import writer for a freshly-created listing or group. */
export const writeMembershipsTx = async (
  tx: TxScope,
  memberships: readonly ImportedMembership[],
): Promise<void> => {
  for (const stmt of membershipStatements(memberships)) await tx.execute(stmt);
};
