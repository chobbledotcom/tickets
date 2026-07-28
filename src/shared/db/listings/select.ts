/**
 * Declarative reads for full listing records.
 *
 * Every full-record listing read used to go through one raw-SQL door:
 * `queryListingsWithCounts(whereClause, args)` took a hand-written `WHERE …`
 * string and a matching arg list, so each caller wrote its own SQL fragment and
 * had to keep the clause order and the arg order in step by eye. `groups.ts`
 * passed a `NOT IN (SELECT …)` subquery as a string; two other callers pasted
 * the base SELECT together with their own tail.
 *
 * This module lets a caller say WHICH listings it wants — {@link ListingWhere} —
 * and in what order, and builds the SQL once. Each present filter field adds one
 * clause that carries its own bound args, so the two can never drift apart.
 *
 * The projections stay whole here on purpose: every caller of these reads builds
 * a `ListingWithCount`, which needs the money, day-price and image values. A
 * read that does NOT need them should not ask for a listing record at all — it
 * should select its own narrow column list with `defineTableProjection`, the way
 * `catalog.ts` and the group-membership picker in `groups.ts` do.
 */

import type { InValue } from "@libsql/client";
import {
  accountBalanceSubquery,
  creditsLessWriteoffDebits,
} from "#shared/accounting/projection-sql.ts";
import { inPlaceholders, queryAll } from "#shared/db/client.ts";
import { imageFilenameSubqueries } from "#shared/db/images.ts";
import type { ListingWithCount } from "#shared/types.ts";

/** A listing's recognised income and servicing cost, projected from the ledger
 * rather than stored columns. */
const listingMoneyProjections = (idExpression: string): string =>
  [
    `${creditsLessWriteoffDebits("revenue", idExpression)} AS income`,
    `-${accountBalanceSubquery("cost", idExpression)} AS cost`,
  ].join(", ");

/** The listing's day-count prices, collapsed into one JSON object so a listing
 * read does not need a second query per row. */
const listingDayPriceProjection = (idExpression: string): string =>
  `COALESCE((SELECT json_group_object(listingPrice.price_id, listingPrice.unit_price)
      FROM listing_prices AS listingPrice
      WHERE listingPrice.listing_id = ${idExpression}
        AND listingPrice.price_type = 'day_count'), '{}') AS day_prices`;

/** A complete stored listing row plus its ledger, day-price, and image values. */
export const listingProjectionSql = (alias: string): string => {
  const idExpression = `${alias}.id`;
  return `${alias}.*,
       ${listingMoneyProjections(idExpression)},
       ${listingDayPriceProjection(idExpression)},
       ${imageFilenameSubqueries("listing", idExpression)}`;
};

/** The SELECT column list for a listing record read: every stored column, the
 * projected values, and the trigger-maintained booking count. */
const listingColumns = (): string =>
  `${listingProjectionSql("listing")},
       listing.booked_quantity AS attendee_count`;

/**
 * A declarative filter for a listing read. Each present field adds one WHERE
 * clause (absent fields don't constrain), so a caller says WHICH listings it
 * wants rather than hand-writing SQL. An empty filter reads every listing.
 */
export type ListingWhere = {
  /** Listings by id. A single listing is a one-element array — there is no
   * separate `= ?` path, so one and many read the same way. */
  ids?: number[];
  /** Listings by the blind index of their slug. A single slug is a
   * one-element array. */
  slugIndexes?: string[];
  /** Listings that are NOT already members of this group — the candidates a
   * group's "add listings" form offers. */
  notInGroup?: number;
  /** Listings that ARE members of any of these groups. This one also changes
   * the shape of the read: it joins through `group_listings`, groups the rows
   * by listing (a listing may be in several of the requested groups), and
   * projects the extra `group_ids` column naming which of them it belongs to.
   * That column is meaningless without this filter, which is why the two are
   * one field rather than a separate opt-in. */
  inGroups?: number[];
  /** Keep only active listings. */
  activeOnly?: boolean;
};

/** How the rows come back. A named order so callers can't hand-roll a stray
 * `ORDER BY`. */
export type ListingOrder = "created_desc";

const ORDER_SQL: Record<ListingOrder, string> = {
  created_desc: "listing.created DESC, listing.id DESC",
};

/** One filter clause and the args that fill its placeholders, kept together so
 * the arg order can never drift from the clause order. */
type WhereClause = { clause: string; args: InValue[] };

const whereClauses = (where: ListingWhere): WhereClause[] => {
  const parts: WhereClause[] = [];
  const inList = (
    column: string,
    values: readonly InValue[] | undefined,
  ): void => {
    if (values === undefined) return;
    // An empty set matches nothing. Emit `IN (NULL)` (always NULL, so no row
    // passes) rather than the syntactically invalid `IN ()`, so the builder
    // still produces valid SQL even if a caller doesn't prefilter an empty list.
    parts.push(
      values.length === 0
        ? { args: [], clause: `${column} IN (NULL)` }
        : {
            args: [...values],
            clause: `${column} IN (${inPlaceholders(values)})`,
          },
    );
  };
  inList("listing.id", where.ids);
  inList("listing.slug_index", where.slugIndexes);
  inList("groupListing.group_id", where.inGroups);
  if (where.notInGroup !== undefined) {
    parts.push({
      args: [where.notInGroup],
      clause:
        "listing.id NOT IN (SELECT listing_id FROM group_listings WHERE group_id = ?)",
    });
  }
  if (where.activeOnly) parts.push({ args: [], clause: "listing.active = 1" });
  return parts;
};

/** Everything a caller declares to read listing records: which rows to keep and
 * in what order. */
export type GetListingsQuery = {
  where: ListingWhere;
  /** Row order. Omit when the caller does not care (a by-id read whose caller
   * re-orders the rows itself). */
  order?: ListingOrder;
};

/**
 * A `queryBatch` statement (SQL + bound args) for a listing read: the single
 * place a declared query becomes runnable SQL. {@link getListingRows} runs it;
 * the activity-log reader embeds it in a batch, and the read-your-own-write
 * reader runs it against the primary.
 */
export const listingStatement = (
  query: GetListingsQuery,
): { sql: string; args: InValue[] } => {
  const parts = whereClauses(query.where);
  const byGroup = query.where.inGroups !== undefined;
  const columns = byGroup
    ? `json_group_array(groupListing.group_id) AS group_ids, ${listingColumns()}`
    : listingColumns();
  // Reading by group starts from the membership rows and folds a listing's
  // several memberships back into one row; every other read starts from the
  // listings themselves.
  const from = byGroup
    ? "FROM group_listings AS groupListing JOIN listings AS listing ON listing.id = groupListing.listing_id"
    : "FROM listings AS listing";
  const where =
    parts.length === 0
      ? ""
      : ` WHERE ${parts.map((part) => part.clause).join(" AND ")}`;
  const groupBy = byGroup ? " GROUP BY listing.id" : "";
  const orderBy =
    query.order === undefined ? "" : ` ORDER BY ${ORDER_SQL[query.order]}`;
  return {
    args: parts.flatMap((part) => part.args),
    sql: `SELECT ${columns} ${from}${where}${groupBy}${orderBy}`,
  };
};

/** The raw shape a listing read returns: the stored columns plus the projected
 * values, before decryption and before any inherited defaults are overlaid. */
export type ListingProjectionRow = Omit<ListingWithCount, "profit">;

/**
 * The one reader every listing-record surface uses: declare the filter and the
 * order, and it returns raw rows. Encrypted columns are still encrypted —
 * decrypt with the readers in `records.ts` before display.
 */
export const getListingRows = (
  query: GetListingsQuery,
): Promise<ListingProjectionRow[]> => {
  const { sql, args } = listingStatement(query);
  return queryAll<ListingProjectionRow>(sql, args);
};
