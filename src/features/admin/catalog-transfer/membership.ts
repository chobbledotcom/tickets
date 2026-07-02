/**
 * Group-membership read/write helpers used only by catalog import/export.
 *
 * Kept out of `#shared/db/groups.ts` so the transfer feature owns its own
 * membership plumbing: exporting a listing's memberships, and (re)creating a
 * group's/listing's memberships — with package overrides, quantities, and
 * per-day overrides — as a **bounded** set of statements. A large group can have
 * many members, so the writes are batched into at most two multi-row INSERTs
 * (one for `group_listings`, one for the `group_day` price rows) rather than a
 * statement per member — an interactive transaction caps at
 * {@link TRANSACTION_ROUNDTRIP_THRESHOLD} statements, which a per-member write
 * would blow past for a ~30-member export.
 */

import type { InValue } from "@libsql/client";
import { queryAll, type TxScope } from "#shared/db/client.ts";
import { PRICE_TYPE_GROUP_DAY } from "#shared/db/listing-prices.ts";
import {
  type DayPrices,
  type GroupListing,
  parseDayPrices,
} from "#shared/types.ts";

/** Every group a listing belongs to, with this listing's per-package override
 * and quantity — the membership facet a catalog export captures for one listing.
 * A `null` `package_price` means "no override"; `quantity` defaults to 1. */
export const getListingGroupMemberships = (
  listingId: number,
): Promise<GroupListing[]> =>
  queryAll<GroupListing>(
    "SELECT group_id, listing_id, package_price, quantity FROM group_listings WHERE listing_id = ? ORDER BY group_id ASC",
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

/** A prepared write statement. */
type Statement = { sql: string; args: InValue[] };

/** Build a multi-row INSERT for `table(columns)` from `rows`, or null when there
 * are no rows. Each row supplies one value per column, in order. */
const multiRowInsert = (
  table: string,
  columns: readonly string[],
  rows: readonly InValue[][],
): Statement | null => {
  if (rows.length === 0) return null;
  const placeholder = `(${columns.map(() => "?").join(", ")})`;
  return {
    args: rows.flat(),
    sql: `INSERT INTO ${table} (${columns.join(", ")}) VALUES ${rows
      .map(() => placeholder)
      .join(", ")}`,
  };
};

/** The (at most two) batched statements that create every membership row plus
 * its `group_day` per-day overrides. Targeted inserts (no group-wide delete), so
 * importing into an already-populated package never disturbs its other members. */
export const membershipStatements = (
  memberships: readonly ImportedMembership[],
): Statement[] => {
  const memberRows = memberships.map((m) => [
    m.groupId,
    m.listingId,
    m.packagePrice,
    m.quantity,
  ]);
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
      ["group_id", "listing_id", "package_price", "quantity"],
      memberRows,
    ),
    multiRowInsert(
      "listing_prices",
      ["listing_id", "price_type", "price_id", "unit_price"],
      dayRows,
    ),
  ].filter((stmt): stmt is Statement => stmt !== null);
};

/** Write every membership (batched) inside an existing write transaction — the
 * catalog-import writer for a freshly-created listing or group. */
export const writeMembershipsTx = async (
  tx: TxScope,
  memberships: readonly ImportedMembership[],
): Promise<void> => {
  for (const stmt of membershipStatements(memberships)) await tx.execute(stmt);
};
