/**
 * The `listing_prices` table: generalised per-listing pricing, one row per
 * (listing, pricing *dimension*, key within it). A `price_type` names the
 * dimension and `price_id` the key:
 *  - `("base", "")`        — the listing's single fixed price (mirrors the
 *                            surviving `listings.unit_price` column, the hot-path
 *                            read; {@link syncListingPrices} keeps it in step).
 *  - `("day_count", "<n>")`— the price for an n-day booking. SOURCE of truth (the
 *                            `listings.day_prices` column was migrated in and
 *                            dropped); written from input by the listing write
 *                            paths and read back via a `json_group_object`
 *                            projection in `db/listings/select.ts`.
 *  - `("group", "<groupId>")` — a package group's flat per-member price override:
 *    the per-unit price this member charges inside that package, whatever the
 *    span. These rows are the SOURCE of truth (the legacy
 *    `group_listings.package_price` column was migrated in and dropped); a member
 *    with no override has no row. {@link groupFlatPriceStatements} writes them and
 *    the `getGroupPackagePrices` subquery in `db/groups.ts` reads them back.
 *  - `("group_day", "<groupId>/<n>")` — a package group's per-day override for
 *    this member: the member's per-unit price for an n-day booking of that
 *    package. Like `group`, these rows are the SOURCE of truth (no legacy column
 *    exists); {@link getGroupDayPrices} is their read API.
 *  - reserved for later: `("start_day", "friday")` (weekday pricing) — the shape
 *    admits it with no schema change; nothing writes it yet.
 *
 * The `base` row mirrors the surviving `listings.unit_price` column; `day_count`,
 * `group`, and `group_day` rows are the SOURCE of truth (their columns were
 * migrated in and dropped, or never existed). This module owns writing all of
 * them.
 */

import { compact, mapNotNullish } from "#fp";
import {
  execute,
  executeBatch,
  inPlaceholders,
  queryAll,
  queryBatchPrimary,
  queryIdColumn,
  type TxScope,
} from "#shared/db/client.ts";
import { type DayPrices, parseDayPrices } from "#shared/types.ts";

export const PRICE_TYPE_BASE = "base";
export const PRICE_TYPE_DAY_COUNT = "day_count";
export const PRICE_TYPE_GROUP = "group";
export const PRICE_TYPE_GROUP_DAY = "group_day";

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

/** The one INSERT every managed dimension shares, parameterised by its
 * (listing, type, key, price) args. */
const insertPriceStatement = (args: PriceRow): PriceStatement => ({
  args,
  sql: "INSERT INTO listing_prices (listing_id, price_type, price_id, unit_price) VALUES (?, ?, ?, ?)",
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
      parseDayPrices(member.dayPrices ?? {}),
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
        (price_type = '${PRICE_TYPE_GROUP}' AND price_id IN (${idText
          .map(() => "?")
          .join(", ")}))
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
    const byDay = result.get(row.listing_id) ?? new Map<number, number>();
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

/** The delete-then-insert statements that make a listing's `base` row match
 * `unitPrice`. The `base` dimension mirrors the surviving `listings.unit_price`
 * column (kept as the hot-path read); {@link syncListingPrices} re-derives it
 * from that column after every write. */
export const basePriceStatements = (
  listingId: number,
  unitPrice: number,
): PriceStatement[] => [
  {
    args: [listingId, PRICE_TYPE_BASE],
    sql: "DELETE FROM listing_prices WHERE listing_id = ? AND price_type = ?",
  },
  insertPriceStatement([listingId, PRICE_TYPE_BASE, "", unitPrice]),
];

/** The statements that make a listing's `day_count` rows exactly match
 * `dayPrices` — a full replace of the listing's per-day prices. Unlike `base`,
 * these rows are the SOURCE of truth (the `listings.day_prices` column was
 * migrated in and dropped), so the write paths call this with the submitted day
 * prices rather than re-deriving from a column. `undefined` normalises to an
 * empty map (the one place that default lives), so callers pass their optional
 * `dayPrices` straight through. Entries are normalised through
 * {@link parseDayPrices} so the rows carry exactly what a reader would accept.
 *
 * The inserts are a SINGLE multi-row statement, so a full replace is at most two
 * statements (one delete + one insert) regardless of how many day counts are
 * offered — the write paths run these inside an interactive transaction, and a
 * per-row insert would cross the round-trip guard for a listing with many day
 * prices. Reserved (`group`/…) rows are left untouched. */
export const dayCountPriceStatements = (
  listingId: number,
  dayPrices: DayPrices | undefined,
): PriceStatement[] => {
  const rows = Object.entries(parseDayPrices(dayPrices ?? {})).map(
    ([days, price]): PriceRow => [listingId, PRICE_TYPE_DAY_COUNT, days, price],
  );
  return compact([
    {
      args: [listingId, PRICE_TYPE_DAY_COUNT],
      sql: "DELETE FROM listing_prices WHERE listing_id = ? AND price_type = ?",
    },
    multiInsertPriceStatement(rows),
  ]);
};

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
  const rows = result.rows as unknown as {
    price_id: string;
    unit_price: number;
  }[];
  const dayPrices: DayPrices = {};
  for (const row of rows) dayPrices[Number(row.price_id)] = row.unit_price;
  return parseDayPrices(dayPrices);
};

/** Replace a listing's `day_count` rows from the submitted `dayPrices`, inside a
 * caller's write transaction — the form/API `afterWrite` hook, so the day prices
 * commit atomically with the listing row (the transactional insertStatement/
 * updateStatement path bypasses the {@link listingsTable} wrapper). */
export const writeListingDayCounts = async (
  tx: TxScope,
  listingId: number,
  dayPrices: DayPrices | undefined,
): Promise<void> => {
  for (const stmt of dayCountPriceStatements(listingId, dayPrices)) {
    await tx.execute(stmt);
  }
};

/** A `listings` row projected to the one column the `base` mirror derives from.
 * `unit_price` may be NULL (read as 0). */
export type ListingPriceSourceRow = {
  id: number;
  unit_price: number | null;
};

/** The `base`-mirror statements for one raw `listings` row — shared by the
 * backfill and the per-listing {@link syncListingPrices}. A NULL `unit_price`
 * reads as 0. Day-count rows are written from input at write time, not from a
 * column, so they are not touched here. */
export const sourceRowStatements = (row: ListingPriceSourceRow) =>
  basePriceStatements(row.id, row.unit_price ?? 0);

/** Listings read per backfill SELECT, and the ceiling on statements per write
 * batch — both bounded so a large site's backfill never materialises the whole
 * table into one libsql batch, which can exceed the edge migrator's payload
 * limits. A single listing contributes at most one delete plus one row per
 * offered day count, so a page stays comfortably within bounds. */
const BACKFILL_LISTING_PAGE = 200;
const BACKFILL_STATEMENT_PAGE = 500;

/** Read the price-source column for a set of listing ids. */
const readSourceRows = async (
  ids: readonly number[],
): Promise<ListingPriceSourceRow[]> => {
  const rows = await execute(
    `SELECT id, unit_price FROM listings
      WHERE id IN (${inPlaceholders(ids)})`,
    [...ids],
  );
  return rows.rows as unknown as ListingPriceSourceRow[];
};

/** Execute the statements in bounded batches so no single write batch grows past
 * {@link BACKFILL_STATEMENT_PAGE}. Each listing's own delete+inserts may straddle
 * a page boundary; the backfill is idempotent, so a re-run still converges. */
const executePaged = async (
  statements: Array<{ sql: string; args: (number | string)[] }>,
): Promise<void> => {
  for (let i = 0; i < statements.length; i += BACKFILL_STATEMENT_PAGE) {
    await executeBatch(statements.slice(i, i + BACKFILL_STATEMENT_PAGE));
  }
};

/** Populate every listing's `base` row from its current `unit_price` — the
 * migration backfill for the `base` mirror. Idempotent: each row is deleted and
 * reinserted, so re-running converges. Paged by listing id (read) and by
 * statement count (write) to stay within edge payload limits on large sites.
 * (Day-count rows are backfilled by the day_prices migration from the column
 * before it is dropped; the per-write paths keep them in step thereafter.) */
export const backfillListingPrices = async (): Promise<void> => {
  const ids = await queryIdColumn("SELECT id FROM listings ORDER BY id");
  for (let i = 0; i < ids.length; i += BACKFILL_LISTING_PAGE) {
    const rows = await readSourceRows(ids.slice(i, i + BACKFILL_LISTING_PAGE));
    await executePaged(rows.flatMap(sourceRowStatements));
  }
};

/** Re-sync the `base` rows for a set of listings from their current
 * `unit_price` — the seed / bulk-clone bulk equivalent of
 * {@link syncListingPrices}, paged the same way as the backfill. Day-count rows
 * are written separately from the day prices those flows carry. */
export const syncListingPricesForIds = async (
  ids: readonly number[],
): Promise<void> => {
  if (ids.length === 0) return;
  const rows = await readSourceRows(ids);
  await executePaged(rows.flatMap(sourceRowStatements));
};

/** Re-sync one listing's `base` row from its current `unit_price` column. Called
 * after every listing insert/update (the form/API `afterCommit`) so the mirror
 * never drifts from the column. The source row is read on the primary
 * (write-mode batch) so it reflects the just-committed write rather than a
 * lagging replica. A missing listing is a no-op. Day-count rows are written from
 * input by the write paths, not re-derived here. */
export const syncListingPrices = async (listingId: number): Promise<void> => {
  const [result] = await queryBatchPrimary([
    {
      args: [listingId],
      sql: "SELECT id, unit_price FROM listings WHERE id = ?",
    },
  ]);
  const row = (result?.rows as unknown as ListingPriceSourceRow[])[0];
  if (row) await executeBatch(sourceRowStatements(row));
};
