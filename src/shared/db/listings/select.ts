/**
 * Declarative reads for full listing records: a caller says WHICH listings it
 * wants — {@link ListingWhere} — and this builds the SQL. Each present filter
 * adds one clause carrying its own bound args, so the two can never drift.
 *
 * The whole record is read on purpose: every caller here builds a
 * `ListingWithCount`, which needs the money, day-price and image values. A read
 * that does not need them should select its own narrow column list with
 * `table.read.pick` instead, as `catalog.ts` and the group-membership
 * picker in `groups.ts` do.
 */

/* jscpd:ignore-start */
import {
  accountBalanceSubquery,
  creditsLessWriteoffDebits,
} from "#shared/accounting/projection-sql.ts";
import { imageFilenameSubqueries } from "#shared/db/images.ts";
import { defineReader } from "#shared/db/read.ts";
import { inList, type WhereClause } from "#shared/db/where-clauses.ts";
import type { ListingWithCount } from "#shared/types.ts";

/* jscpd:ignore-end */

/** A listing's recognised income and servicing cost, worked out from the ledger
 * rather than stored columns. */
const listingMoneyProjections = (idExpression: string): string =>
  [
    `${creditsLessWriteoffDebits("revenue", idExpression)} AS income`,
    `-${accountBalanceSubquery("cost", idExpression)} AS cost`,
  ].join(", ");

/** The listing's day-count prices, collapsed into one JSON object so a listing
 * read does not need a second query per row. */
const listingDayPriceColumn = (idExpression: string): string =>
  `COALESCE((SELECT json_group_object(listingPrice.price_id, listingPrice.unit_price)
      FROM listing_prices AS listingPrice
      WHERE listingPrice.listing_id = ${idExpression}
        AND listingPrice.price_type = 'day_count'), '{}') AS day_prices`;

/** A complete stored listing row plus its ledger, day-price, and image values. */
const storedListingColumns = (alias: string): string => {
  const idExpression = `${alias}.id`;
  return `${alias}.*,
       ${listingMoneyProjections(idExpression)},
       ${listingDayPriceColumn(idExpression)},
       ${imageFilenameSubqueries("listing", idExpression)}`;
};

/** The SELECT column list for a listing record read: every stored column, the
 * worked-out values, and the trigger-maintained booking count. */
const listingColumns = (): string =>
  `${storedListingColumns("listing")},
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
 * `ORDER BY`. Exported because a narrow listing read — one that selects its own
 * columns rather than the whole record — still wants to come back in the same
 * order as the full reads. */
export type ListingOrder = "created_desc";

export const LISTING_ORDER_SQL: Record<ListingOrder, string> = {
  created_desc: "listing.created DESC, listing.id DESC",
};

const whereClauses = (where: ListingWhere): WhereClause[] => [
  ...inList("listing.id", where.ids),
  ...inList("listing.slug_index", where.slugIndexes),
  ...inList("groupListing.group_id", where.inGroups),
  ...(where.activeOnly ? [{ args: [], clause: "listing.active = 1" }] : []),
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
export const listingReader = defineReader<ListingOrder, GetListingsQuery>(
  LISTING_ORDER_SQL,
  (query) => {
    const byGroup = query.where.inGroups !== undefined;
    return {
      columns: byGroup
        ? `json_group_array(groupListing.group_id) AS group_ids, ${listingColumns()}`
        : listingColumns(),
      from: byGroup
        ? "group_listings AS groupListing JOIN listings AS listing ON listing.id = groupListing.listing_id"
        : "listings AS listing",
      groupBy: byGroup ? "listing.id" : undefined,
      where: whereClauses(query.where),
    };
  },
);

/** The raw shape a listing read returns: the stored columns plus the worked-out
 * values, before decryption and before any inherited defaults are overlaid. */
export type ListingRecordRow = Omit<ListingWithCount, "profit">;

/**
 * The one reader every listing-record surface uses: declare the filter and the
 * order, and it returns raw rows. Encrypted columns are still encrypted —
 * decrypt with the readers in `records.ts` before display.
 */
export const getListingRows = (
  query: GetListingsQuery,
): Promise<ListingRecordRow[]> => listingReader.rows<ListingRecordRow>(query);
