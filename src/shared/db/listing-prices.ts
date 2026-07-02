/**
 * The `listing_prices` table: generalised per-listing pricing, one row per
 * (listing, pricing *dimension*, key within it). A `price_type` names the
 * dimension and `price_id` the key:
 *  - `("base", "")`        — the listing's single fixed price (mirrors
 *                            `listings.unit_price`).
 *  - `("day_count", "<n>")`— the price for an n-day booking (mirrors an entry of
 *                            `listings.day_prices`).
 *  - `("group_day", "<groupId>/<n>")` — a package group's per-day override for
 *    this member: the member's per-unit price for an n-day booking of that
 *    package. Unlike the mirrors above, these rows are the SOURCE of truth (no
 *    legacy column exists); {@link getGroupDayPrices} is their read API.
 *  - reserved for later: `("group", "<groupId>")` (flat group overrides — the
 *    flat package price still lives on `group_listings.package_price`),
 *    `("start_day", "friday")` (weekday pricing) — the shape admits them with no
 *    schema change; nothing writes them yet.
 *
 * The `base`/`day_count` rows are backfilled from, and kept in step with,
 * `listings.unit_price`/`day_prices`, which stay as the source-of-truth mirror
 * columns every display/API/charge caller still reads. This module owns writing
 * those rows.
 */

import {
  execute,
  executeBatch,
  inPlaceholders,
  queryBatchPrimary,
  queryIdColumn,
} from "#shared/db/client.ts";
import { type DayPrices, parseDayPrices } from "#shared/types.ts";

export const PRICE_TYPE_BASE = "base";
export const PRICE_TYPE_DAY_COUNT = "day_count";
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

/** The one INSERT every managed dimension shares, parameterised by its
 * (listing, type, key, price) args. */
const insertPriceStatement = (
  args: [number, string, string, number],
): PriceStatement => ({
  args,
  sql: "INSERT INTO listing_prices (listing_id, price_type, price_id, unit_price) VALUES (?, ?, ?, ?)",
});

/** The delete-then-insert statements that make a package group's `group_day`
 * rows exactly match the submitted members — a full replace per group, so a
 * removed member's stale overrides can't outlive it. Entries are normalised
 * through {@link parseDayPrices} like every other day-price write. */
export const groupDayPriceStatements = (
  groupId: number,
  members: readonly GroupDayPriceInput[],
): PriceStatement[] => {
  const statements: PriceStatement[] = [
    {
      args: [PRICE_TYPE_GROUP_DAY, groupDayPriceId(groupId, "%")],
      sql: "DELETE FROM listing_prices WHERE price_type = ? AND price_id LIKE ?",
    },
  ];
  for (const member of members) {
    const dayPrices = parseDayPrices(member.dayPrices ?? {});
    for (const [days, price] of Object.entries(dayPrices)) {
      statements.push(
        insertPriceStatement([
          member.listingId,
          PRICE_TYPE_GROUP_DAY,
          groupDayPriceId(groupId, days),
          price,
        ]),
      );
    }
  }
  return statements;
};

/** A raw `group_day` row as SELECTed for the readers below. */
type GroupDayRow = { listing_id: number; price_id: string; unit_price: number };

/** Fold `group_day` rows into the {@link GroupDayPrices} map, deriving each
 * row's day count from its `"<groupId>/<n>"` price_id. */
const foldGroupDayRows = (
  rows: readonly GroupDayRow[],
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

/** One package group's per-day member overrides. Empty when none are set. */
export const getGroupDayPrices = async (
  groupId: number,
): Promise<Map<number, Map<number, number>>> => {
  const result = await execute(
    "SELECT listing_id, price_id, unit_price FROM listing_prices WHERE price_type = ? AND price_id LIKE ?",
    [PRICE_TYPE_GROUP_DAY, groupDayPriceId(groupId, "%")],
  );
  return foldGroupDayRows(result.rows as unknown as GroupDayRow[]);
};

/** Per-day member overrides for several groups in one query (the API list
 * endpoint's bulk hydration), keyed by group id. Groups without overrides are
 * absent. Reads every `group_day` row and splits by the price_id's group prefix
 * — groups are few, so one unfiltered SELECT beats a LIKE per group. */
export const getGroupDayPricesByGroupIds = async (
  groupIds: readonly number[],
): Promise<Map<number, Map<number, Map<number, number>>>> => {
  if (groupIds.length === 0) return new Map();
  const wanted = new Set(groupIds);
  const rows = await execute(
    "SELECT listing_id, price_id, unit_price FROM listing_prices WHERE price_type = ?",
    [PRICE_TYPE_GROUP_DAY],
  );
  const rowsByGroup = new Map<number, GroupDayRow[]>();
  for (const row of rows.rows as unknown as GroupDayRow[]) {
    const groupId = Number(row.price_id.split("/")[0]);
    if (!wanted.has(groupId)) continue;
    const list = rowsByGroup.get(groupId);
    if (list) list.push(row);
    else rowsByGroup.set(groupId, [row]);
  }
  return new Map(
    [...rowsByGroup].map(([groupId, groupRows]) => [
      groupId,
      foldGroupDayRows(groupRows),
    ]),
  );
};

/** The delete-then-insert statements that make a listing's `base`/`day_count`
 * rows exactly match `unitPrice` + `dayPrices`. Only these two managed
 * dimensions are touched — any reserved (`group`/…) rows are left untouched. A
 * day-count entry is normalised through {@link parseDayPrices} so the rows carry
 * exactly what a reader would accept. */
export const listingPriceStatements = (
  listingId: number,
  unitPrice: number,
  dayPrices: DayPrices,
): PriceStatement[] => {
  const statements: PriceStatement[] = [
    {
      args: [listingId, PRICE_TYPE_BASE, PRICE_TYPE_DAY_COUNT],
      sql: "DELETE FROM listing_prices WHERE listing_id = ? AND price_type IN (?, ?)",
    },
    insertPriceStatement([listingId, PRICE_TYPE_BASE, "", unitPrice]),
  ];
  for (const [days, price] of Object.entries(parseDayPrices(dayPrices))) {
    statements.push(
      insertPriceStatement([listingId, PRICE_TYPE_DAY_COUNT, days, price]),
    );
  }
  return statements;
};

/** A `listings` row projected to just the columns the managed price rows mirror.
 * `day_prices` is the stored JSON text; `unit_price` may be NULL (read as 0). */
export type ListingPriceSourceRow = {
  id: number;
  unit_price: number | null;
  day_prices: string;
};

/** The managed statements that sync one raw `listings` row's `base`/`day_count`
 * rows — the {@link listingPriceStatements} call shared by the backfill and the
 * per-listing {@link syncListingPrices}, so both normalise the stored JSON the
 * same way. A NULL `unit_price` reads as 0 and blank/absent `day_prices` as an
 * empty map. */
export const sourceRowStatements = (row: ListingPriceSourceRow) =>
  listingPriceStatements(
    row.id,
    row.unit_price ?? 0,
    parseDayPrices(JSON.parse(row.day_prices || "{}")),
  );

/** Listings read per backfill SELECT, and the ceiling on statements per write
 * batch — both bounded so a large site's backfill never materialises the whole
 * table into one libsql batch, which can exceed the edge migrator's payload
 * limits. A single listing contributes at most one delete plus one row per
 * offered day count, so a page stays comfortably within bounds. */
const BACKFILL_LISTING_PAGE = 200;
const BACKFILL_STATEMENT_PAGE = 500;

/** Read the price-source columns for a set of listing ids. */
const readSourceRows = async (
  ids: readonly number[],
): Promise<ListingPriceSourceRow[]> => {
  const rows = await execute(
    `SELECT id, unit_price, day_prices FROM listings
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

/** Populate `listing_prices` from every listing's current `unit_price`/
 * `day_prices` — the migration backfill. Idempotent: each listing's managed
 * rows are deleted and reinserted, so re-running converges. Paged by listing id
 * (read) and by statement count (write) to stay within edge payload limits on
 * large sites. */
export const backfillListingPrices = async (): Promise<void> => {
  const ids = await queryIdColumn("SELECT id FROM listings ORDER BY id");
  for (let i = 0; i < ids.length; i += BACKFILL_LISTING_PAGE) {
    const rows = await readSourceRows(ids.slice(i, i + BACKFILL_LISTING_PAGE));
    await executePaged(rows.flatMap(sourceRowStatements));
  }
};

/** Re-sync the managed price rows for a set of listings from their current
 * `listings` columns — the seed flow's bulk equivalent of
 * {@link syncListingPrices}, paged the same way as the backfill. */
export const syncListingPricesForIds = async (
  ids: readonly number[],
): Promise<void> => {
  if (ids.length === 0) return;
  const rows = await readSourceRows(ids);
  await executePaged(rows.flatMap(sourceRowStatements));
};

/** Re-sync one listing's managed price rows from its current `listings` columns.
 * Called after every listing insert/update so the table never drifts from the
 * `unit_price`/`day_prices` mirrors. The source row is read on the primary
 * (write-mode batch) so it reflects the just-committed write rather than a
 * lagging replica. A missing listing is a no-op. */
export const syncListingPrices = async (listingId: number): Promise<void> => {
  const [result] = await queryBatchPrimary([
    {
      args: [listingId],
      sql: "SELECT id, unit_price, day_prices FROM listings WHERE id = ?",
    },
  ]);
  const row = (result?.rows as unknown as ListingPriceSourceRow[])[0];
  if (row) await executeBatch(sourceRowStatements(row));
};
