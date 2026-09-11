/**
 * One row per (listing, pricing *dimension*, key within it).
 *
 *  - `("base", "")` mirrors the hot-path `listings.unit_price` column —
 *    `listing-price-sync.ts` keeps it in step.
 *  - `("group", "<groupId>")` is what a member charges per unit inside that
 *    package, whatever the span. A member with no override has no row.
 *  - `("start_day", "friday")` is reserved for weekday pricing. The shape
 *    admits it with no schema change, and nothing writes it yet.
 */

import * as v from "valibot";
import { execute, inPlaceholders, queryAll, type TxScope } from "#db/client.ts";
import { requireTouchingRelationshipsTx } from "#db/listing-parents.ts";
import {
  PRICE_TYPE_DAY_COUNT,
  PRICE_TYPE_GROUP,
  PRICE_TYPE_GROUP_DAY,
} from "#db/price-types.ts";
import { compact, mapNotNullish } from "#fp";
import { type DayPrices, parseDayPrices } from "#types";

/** The `price_id` composition for one (package group, day count) override. The
 * trailing `/` keeps LIKE prefixes exact: group 1's `1/%` can never match group
 * 12's `12/3`. */
const groupDayPriceId = (groupId: number, dayCount: number | string): string =>
  `${groupId}/${dayCount}`;

/** A package group's per-day member overrides: listing id → (day count →
 * per-unit minor price). The shape every group-day consumer reads. */
export type GroupDayPrices = ReadonlyMap<number, ReadonlyMap<number, number>>;

/** One member's per-day overrides as written by the group save. */
export type GroupDayPriceInput = {
  listingId: number;
  /** Day count → per-unit minor price; only counts the listing itself offers
   * ever take effect (pricing consults the override before the listing's own
   * day price, never inventing a new span). */
  dayPrices?: DayPrices | undefined;
};

/** One managed `listing_prices` write statement. */
type PriceStatement = { sql: string; args: (number | string)[] };

/** One managed price row's (listing, type, key, price) tuple. */
type PriceRow = [number, string, string, number];

/** The delete that clears one managed dimension's rows for one listing — the
 * head of every delete-then-insert replace this module writes. */
const priceDimensionDelete =
  (priceType: string) =>
  (listingId: number): PriceStatement => ({
    args: [listingId, priceType],
    sql: "DELETE FROM listing_prices WHERE listing_id = ? AND price_type = ?",
  });

/** A SINGLE multi-row INSERT over the managed price rows, or `null` when there
 * are none. Every full-replace dimension (`day_count`, `group`, `group_day`)
 * pairs its delete with one of these, so a replace is at most two statements
 * regardless of row count — the write paths run them inside an interactive
 * transaction, and a per-row insert would trip the round-trip guard. */
const multiInsertPriceStatement = (
  rows: readonly PriceRow[],
): PriceStatement | null => {
  if (rows.length === 0) return null;
  return {
    args: rows.flat(),
    sql: `INSERT INTO listing_prices (listing_id, price_type, price_id, unit_price) VALUES ${rows
      .map(() => "(?, ?, ?, ?)")
      .join(", ")}`,
  };
};

/** The delete-then-insert statements that make a package group's `group_day`
 * rows exactly match the submitted members — a full replace per group, so a
 * removed member's stale overrides can't outlive it. Entries are normalised
 * through {@link parseDayPrices} like every other day-price write, and the
 * inserts are a single multi-row statement (see {@link multiInsertPriceStatement}). */
export const groupDayPriceStatements = (
  groupId: number,
  members: readonly GroupDayPriceInput[],
): PriceStatement[] => {
  const rows: PriceRow[] = [];
  for (const member of members) {
    for (const [days, price] of Object.entries(
      parseDayPrices(member.dayPrices || {}),
    )) {
      rows.push([
        member.listingId,
        PRICE_TYPE_GROUP_DAY,
        groupDayPriceId(groupId, days),
        price,
      ]);
    }
  }
  return compact([
    {
      args: [PRICE_TYPE_GROUP_DAY, groupDayPriceId(groupId, "%")],
      sql: "DELETE FROM listing_prices WHERE price_type = ? AND price_id LIKE ?",
    },
    multiInsertPriceStatement(rows),
  ]);
};

/** One member's flat package override as applied by the group save. `price` is
 * the per-unit minor override; `null`/absent means "no override" — no row is
 * written (the member charges its own price), matching the old NULLable column. */
export type GroupFlatPriceInput = {
  listingId: number;
  price?: number | null;
};

/** The delete-then-insert statements that make a package group's flat `group`
 * rows exactly match the submitted members — a full replace per group (keyed by
 * the group id in `price_id`), so a removed member's stale override can't outlive
 * it. Only members with a real override (a non-null `price`, including an explicit
 * free `0`) get a row; the rest are simply absent, exactly like the old NULL. */
export const groupFlatPriceStatements = (
  groupId: number,
  members: readonly GroupFlatPriceInput[],
): PriceStatement[] => {
  const rows = mapNotNullish((member: GroupFlatPriceInput): PriceRow | null =>
    member.price === null || member.price === undefined
      ? null
      : [member.listingId, PRICE_TYPE_GROUP, String(groupId), member.price],
  )(members);
  return compact([
    {
      args: [PRICE_TYPE_GROUP, String(groupId)],
      sql: "DELETE FROM listing_prices WHERE price_type = ? AND price_id = ?",
    },
    multiInsertPriceStatement(rows),
  ]);
};

/** The statement that drops a listing's package price overrides — flat `group`
 * and per-day `group_day` — for a set of groups it is LEAVING. When a listing is
 * unticked from a package, its `group_listings` row goes but the price rows live
 * in `listing_prices`; without this they'd survive and a later re-add would
 * resurrect the stale override (the retired `group_listings.package_price` column
 * was deleted with the membership row, so re-adding started from no override). A
 * single statement regardless of how many groups, to stay within the interactive
 * round-trip guard. `null` for an empty set (nothing to drop). */
export const removeListingGroupPricesStatement = (
  listingId: number,
  groupIds: readonly number[],
): PriceStatement | null => {
  if (groupIds.length === 0) return null;
  const idText = groupIds.map(String);
  // Each group's group_day price_ids are "<groupId>/<n>"; the trailing "/" keeps
  // the LIKE exact (group 1's "1/%" never matches group 12's "12/3").
  const globs = groupIds.map((id) => `${id}/%`);
  return {
    args: [listingId, ...idText, ...globs],
    sql: `DELETE FROM listing_prices WHERE listing_id = ? AND (
        (price_type = '${PRICE_TYPE_GROUP}' AND price_id IN (${inPlaceholders(
          idText,
        )}))
        OR (price_type = '${PRICE_TYPE_GROUP_DAY}' AND (${globs
          .map(() => "price_id LIKE ?")
          .join(" OR ")}))
      )`,
  };
};

/** A raw day-price row as selected from `listing_prices`. */
export type DayPriceRow = {
  listing_id: number;
  price_id: string;
  unit_price: number;
};

/** Fold `group_day` rows into the {@link GroupDayPrices} map, deriving each
 * row's day count from its `"<groupId>/<n>"` price_id. */
const foldGroupDayRows = (
  rows: readonly DayPriceRow[],
): Map<number, Map<number, number>> => {
  const result = new Map<number, Map<number, number>>();
  for (const row of rows) {
    const dayCount = Number(row.price_id.split("/")[1]);
    const byDay = result.get(row.listing_id) || new Map<number, number>();
    byDay.set(dayCount, row.unit_price);
    result.set(row.listing_id, byDay);
  }
  return result;
};

/** One package group's per-day member overrides. Empty when none are set. The
 * membership JOIN keeps a REMOVED member's leftover rows invisible: the listing
 * edit/API path deletes only the `group_listings` row, so re-adding that member
 * later must start from "no overrides" rather than resurrecting stale prices
 * (the next package save's full replace then clears them for good). */
export const getGroupDayPrices = async (
  groupId: number,
): Promise<Map<number, Map<number, number>>> =>
  (await getGroupDayPricesByGroupIds([groupId])).get(groupId)!;

/** Per-day member overrides for several groups in one query (the API list
 * endpoint's bulk hydration), keyed by group id. Every requested group is
 * present. Reads every CURRENT member's `group_day` row (the JOIN's composed
 * pattern scopes each row to its own group's membership, exactly like
 * {@link getGroupDayPrices}) and splits by the price_id's group prefix —
 * and bounds the query to the requested groups. */
export const getGroupDayPricesByGroupIds = async (
  groupIds: readonly number[],
): Promise<Map<number, Map<number, Map<number, number>>>> => {
  const groups = new Map(
    [...new Set(groupIds)].map((groupId) => [
      groupId,
      new Map<number, Map<number, number>>(),
    ]),
  );
  if (groups.size === 0) return groups;
  const ids = [...groups.keys()];
  const rows = await queryAll<DayPriceRow>(
    `SELECT listingPrice.listing_id, listingPrice.price_id, listingPrice.unit_price
       FROM listing_prices AS listingPrice
       JOIN group_listings AS groupListing
         ON groupListing.listing_id = listingPrice.listing_id
        AND listingPrice.price_id LIKE (groupListing.group_id || '/%')
      WHERE listingPrice.price_type = ?
        AND groupListing.group_id IN (${inPlaceholders(ids)})`,
    [PRICE_TYPE_GROUP_DAY, ...ids],
  );
  const groupIdOf = (row: DayPriceRow): number =>
    Number(row.price_id.split("/")[0]);
  for (const [groupId, groupRows] of Map.groupBy(rows, groupIdOf)) {
    groups.set(groupId, foldGroupDayRows(groupRows));
  }
  return groups;
};

/** A full replace of a listing's per-day prices. These rows are the SOURCE of
 * truth, so the write paths pass the submitted prices rather than re-derive
 * from a column. `undefined` normalises to an empty map here, the one place
 * that default lives.
 *
 * The inserts are a SINGLE multi-row statement, so a full replace is at most
 * two statements however many day counts are offered. The write paths run
 * inside an interactive transaction, and a per-row insert would cross the
 * round-trip guard. Reserved rows are left untouched. */
export const dayCountPriceStatements = (
  listingId: number,
  dayPrices: DayPrices | undefined,
): PriceStatement[] => {
  const rows = Object.entries(parseDayPrices(dayPrices || {})).map(
    ([days, price]): PriceRow => [listingId, PRICE_TYPE_DAY_COUNT, days, price],
  );
  return compact([
    priceDimensionDelete(PRICE_TYPE_DAY_COUNT)(listingId),
    multiInsertPriceStatement(rows),
  ]);
};

/** One `listing_prices` `day_count` row: the day count it prices and its
 * per-unit price. */
const DayCountPriceRowSchema = v.object({
  price_id: v.string(),
  unit_price: v.number(),
});

/** One listing's per-day-count prices from its `day_count` rows, as a
 * {@link DayPrices} map. The bounded single-listing read used to keep an entity
 * honest when the write path can't supply the day prices (a partial update),
 * paralleling how the loaders project the same rows in bulk. Empty when none. */
export const getListingDayPrices = async (
  listingId: number,
): Promise<DayPrices> => {
  const result = await execute(
    `SELECT price_id, unit_price FROM listing_prices
      WHERE listing_id = ? AND price_type = ?`,
    [listingId, PRICE_TYPE_DAY_COUNT],
  );
  const dayPrices: DayPrices = {};
  for (const row of v.parse(v.array(DayCountPriceRowSchema), result.rows)) {
    dayPrices[Number(row.price_id)] = row.unit_price;
  }
  return parseDayPrices(dayPrices);
};

/** Replace day prices, finish any relationship change that depends on them, then
 * check every edge against the saved listing's final state. */
export const writeListingDayCounts = async (
  tx: TxScope,
  listingId: number,
  dayPrices: DayPrices | undefined,
  finishRelationships?: () => Promise<void>,
): Promise<void> => {
  for (const stmt of dayCountPriceStatements(listingId, dayPrices)) {
    await tx.execute(stmt);
  }
  if (finishRelationships) await finishRelationships();
  await requireTouchingRelationshipsTx(tx, listingId);
};
