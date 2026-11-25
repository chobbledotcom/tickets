/**
 * Declarative reads for full listing records: a caller says WHICH listings it
 * wants — {@link ListingWhere} — and this builds the SQL. Each present filter
 * adds one clause carrying its own bound args, so the two can never drift.
 *
 * The whole record is read on purpose: every caller here builds a
 * `ListingWithCount`, which needs the money, day-price and image values. A read
 * that does not need them picks its own columns with the builder, as
 * `catalog.ts` and `groups/candidates.ts` do.
 */

import { listingIncomeSubquery } from "#accounting/figures.ts";
import {
  type AccountId,
  accountBalanceSubquery,
} from "#accounting/projection-sql.ts";
import type { BlindIndex } from "#crypto/sealed.ts";
import { imageFilenameSubqueries, type SealedItemImages } from "#db/images.ts";
import { everyColumnPicked } from "#db/picked-columns.ts";
import { readRows } from "#db/read.ts";
import {
  among,
  type Condition,
  equal,
  given,
  literal,
} from "#db/select/expression.ts";
import { from, tableNode } from "#db/select/query.ts";
import { type DecodedRowOf, tables } from "#db/select/tables.ts";
import { type SqlStatement, sql } from "#db/sql.ts";
import type { ListingWithCount } from "#types";

/** The listing row of a statement that names the table
 *  `listings AS listing`. */
export const LISTING_ROW = tableNode(tables.listings, "listing");

/** Every stored column of the listing, which the client decodes. */
const STORED_COLUMNS = everyColumnPicked(tables.listings, "listing");

/** Mark a read that selects {@link listingColumns}, so the client decodes the
 *  stored columns of its rows. */
export const decodedListingRead = STORED_COLUMNS.decoded;

/** A listing's recognised income and servicing cost, worked out from the ledger
 * rather than stored columns. */
const listingMoneyProjections = (idExpression: AccountId): SqlStatement =>
  sql`${listingIncomeSubquery(idExpression)} AS income, -${accountBalanceSubquery("cost", idExpression)} AS cost`;

/** A complete stored listing row plus its ledger, day-price, and image values. */
const storedListingColumns = (): SqlStatement => {
  const idExpression = LISTING_ROW.id;
  return sql`${STORED_COLUMNS.list},
       ${listingMoneyProjections(idExpression)},
       COALESCE((SELECT json_group_object(listingPrice.price_id, listingPrice.unit_price)
         FROM listing_prices AS listingPrice
         WHERE listingPrice.listing_id = ${idExpression}
           AND listingPrice.price_type = 'day_count'), '{}') AS dayPrices,
       ${imageFilenameSubqueries("listing", idExpression)}`;
};

/** The SELECT column list for a listing record read: every stored column, the
 * worked-out values, and the trigger-maintained booking count. A read that
 * writes its own conditions selects this list under `listings AS listing`, and
 * marks the read with {@link decodedListingRead}. */
export const listingColumns = (): SqlStatement =>
  sql`${storedListingColumns()},
       listing.booked_quantity AS attendeeCount`;

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
  slugIndexes?: BlindIndex[];
  /** Listings that are members of any of these groups. This filter also
   * changes the shape of the read. The read joins through `group_listings` and
   * groups the rows by listing, because a listing can be in several groups.
   * It adds the `group_ids` column, which names the groups of the listing.
   * That column has no meaning without this filter, so the two are one field. */
  inGroups?: number[];
  /** Keep only active listings. */
  activeOnly?: boolean;
};

/** How the rows come back. A named order so callers can't hand-roll a stray
 * `ORDER BY`. Exported because a narrow listing read — one that selects its own
 * columns rather than the whole record — still wants to come back in the same
 * order as the full reads. */
export type ListingOrder = "created_desc";

export const LISTING_ORDER_SQL: Record<ListingOrder, SqlStatement> = {
  created_desc: sql`listing.created DESC, listing.id DESC`,
};

/** The membership row of a read by group, which names the table
 *  `group_listings AS groupListing`. */
const MEMBERSHIP_ROW = tableNode(tables.group_listings, "groupListing");

const whereConditions = (where: ListingWhere): Condition[] => [
  given(where.ids, (ids) => among(LISTING_ROW.id, ids)),
  given(where.slugIndexes, (indexes) => among(LISTING_ROW.slugIndex, indexes)),
  given(where.inGroups, (groups) => among(MEMBERSHIP_ROW.groupId, groups)),
  where.activeOnly ? equal(LISTING_ROW.active, literal(1)) : true,
];

/** Everything a caller declares to read listing records: which rows to keep and
 * in what order. */
export type GetListingsQuery = {
  where: ListingWhere;
  /** Row order. Omit when the caller does not care (a by-id read whose caller
   * re-orders the rows itself). */
  order?: ListingOrder;
};

/**
 * The listing reader. Reading by group starts from the membership rows and
 * folds a listing's several memberships back into one row, naming which groups
 * it matched; every other read starts from the listings themselves.
 */
const listingStatement = (query: GetListingsQuery): SqlStatement => {
  const conditions = whereConditions(query.where);
  const order =
    query.order === undefined ? [] : [LISTING_ORDER_SQL[query.order]];
  return decodedListingRead(
    query.where.inGroups === undefined
      ? from(tables.listings)
          .where(() => conditions)
          .orderBy(() => order)
          .columns(listingColumns)
      : from(tables.group_listings, { listing: {} })
          .where(() => conditions)
          .groupBy((member) => [member.listing.id])
          .orderBy(() => order)
          .columns(
            (member) =>
              sql`json_group_array(${member.groupId}) AS group_ids, ${listingColumns()}`,
          ),
  );
};

/** The statement, for a caller that must embed the read in a batch, and the
 *  rows, for everyone else. The row shape is the caller's to name. */
export const listingReader = {
  rows: <Row>(query: GetListingsQuery): Promise<Row[]> =>
    readRows<Row>(listingStatement(query)),
  statement: listingStatement,
};

/** The shape a listing read returns: the decoded stored columns plus the
 * worked-out values, before the projected values are opened and before any
 * inherited defaults are overlaid. */
export type ListingRecordRow = DecodedRowOf<"listings"> &
  SealedItemImages &
  Pick<ListingWithCount, "attendeeCount"> & {
    cost: number | bigint;
    dayPrices: string;
    income: number | bigint;
  };

/**
 * The one reader every listing-record surface uses: declare the filter and the
 * order, and it returns the rows. The projected day prices and images are
 * still sealed. Open them with the readers in `records.ts` before display.
 */
export const getListingRows = (
  query: GetListingsQuery,
): Promise<ListingRecordRow[]> => listingReader.rows<ListingRecordRow>(query);
