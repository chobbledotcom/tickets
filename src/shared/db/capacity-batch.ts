/**
 * The cart read preflight's SQL: whether a whole cart's demand fits right now.
 * It reuses the write predicate's counting subqueries from `#db/capacity.ts`,
 * so the read-time preflight and the write-time guard can never count
 * capacity differently. The public checkout books every dated line on one
 * date and filters zero quantities before the preflight. Multi-date carts
 * and zero-quantity lines reach these clauses only from an operator's
 * hand-built creation or edit.
 *
 * One clause per listing and per group, the bucket's per-day demands as a
 * VALUES table — far under SQLite's expression-depth limit at 12 x 90 days.
 */

import type { BatchAvailabilityItem } from "#db/attendee-types.ts";
import { expandDailyRange } from "#db/attendees/capacity/range.ts";
import type { ListingCapacityRow } from "#db/attendees/capacity/types.ts";
import {
  buildGroupCountSql,
  buildListingCountSql,
  type CountingDayRange,
  dateToRange,
} from "#db/capacity.ts";

import {
  type SqlStatement,
  sql,
  sqlCommas,
  sqlJoin,
  sqlLiteral,
  sqlName,
} from "#db/sql.ts";
import { countsPerDate } from "#shared/capacity-rules.ts";
import { parseDateStringOrThrow } from "#shared/validation/date-string.ts";

/** One listing's or one group's cart demand. `perDay` holds the dated demand
 * on per-date counting listings, keyed by day. `everyDay` holds demand that
 * occupies the cap on every date too — lines on date-less-cap listings, whose
 * running total every statement counts. `undatedOnly` holds date-less lines
 * on per-date listings, which no dated statement of the write can ever see:
 * only the undated clause counts them. `runningTotal` holds every line's
 * quantity once, in write order — what the aggregate trigger adds to
 * `booked_quantity` per inserted line. `throughLastUndated` snapshots that
 * total at the bucket's last date-less line: the state the write's last
 * undated statement reads, because a dated line booked after it raises the
 * running total but no undated statement runs after that. */
export type CapacityBucket = {
  everyDay: number;
  perDay: Map<string, number>;
  undatedOnly: number;
  runningTotal: number;
  throughLastUndated: number;
};

/** One cart's whole demand, listing buckets beside group buckets. */
export type CartDemand = {
  groupDemand: Map<number, CapacityBucket>;
  listingDemand: Map<number, CapacityBucket>;
};

/** Find one bucket in the map, creating an empty one on first touch. */
export const getOrCreateBucket = <K>(
  buckets: Map<K, CapacityBucket>,
  key: K,
): CapacityBucket => {
  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = {
      everyDay: 0,
      perDay: new Map(),
      runningTotal: 0,
      throughLastUndated: 0,
      undatedOnly: 0,
    };
    buckets.set(key, bucket);
  }
  return bucket;
};

/** Add one cart line's demand to its listing's or group's bucket. A
 * zero-quantity line demands nothing and adds nothing. Dated lines on
 * per-date counting listings occupy their days; every other line only
 * bumps the running total the write's statements count — a date-less line
 * on a per-date listing is visible to that total alone. A date-less line
 * also pins the running total its write statement reads: no undated
 * statement of the write runs after it, so a dated line booked later never
 * raises that state. */
export const addDemandToBucket = (
  bucket: CapacityBucket,
  listing: Pick<ListingCapacityRow, "listing_type">,
  item: BatchAvailabilityItem,
  date: string | null | undefined,
): void => {
  if (item.quantity <= 0) return;
  bucket.runningTotal += item.quantity;
  if (!countsPerDate(listing.listing_type)) {
    bucket.everyDay += item.quantity;
    bucket.throughLastUndated = bucket.runningTotal;
    return;
  }
  if (!date) {
    bucket.undatedOnly += item.quantity;
    bucket.throughLastUndated = bucket.runningTotal;
    return;
  }
  for (const day of expandDailyRange(
    parseDateStringOrThrow(date, "a stored booking date"),
    item.durationDays ?? 1,
  )) {
    bucket.perDay.set(day, (bucket.perDay.get(day) ?? 0) + item.quantity);
  }
};

const hasUndatedDemand = (bucket: CapacityBucket): boolean =>
  bucket.everyDay > 0 || bucket.undatedOnly > 0;

/** The bucket's per-day rows as VALUES tuples of (start_at, end_at, qty). The
 * demand quantity stays a literal: it is a non-negative cart total, never
 * user-typed text. */
const dayDemandRows = (bucket: CapacityBucket): SqlStatement =>
  sqlCommas(
    [...bucket.perDay].map(([day, qty]) => {
      const { endAt, startAt } = dateToRange(day);
      return sql`(${startAt}, ${endAt}, ${sqlLiteral(qty)})`;
    }),
  );

const DAY_RANGE: CountingDayRange = {
  endSql: sqlName("dayDemand.column2"),
  startSql: sqlName("dayDemand.column1"),
};

/** The per-kind cap rule: whether an overflow against a cap is a refusal. */
type Violation = (overflow: SqlStatement, cap: SqlStatement) => SqlStatement;

/** Refuse when any single day's occupancy plus that day's cart demand, on
 * top of the demand every date carries, breaks the cap. `violation` is the
 * per-kind cap rule: a listing refuses on a NULL cap (the write's inactive
 * listing refusal), a group passes an uncapped cap of 0 (the write's
 * `max_attendees > 0` gate). */
const perDayClause = (
  capSql: SqlStatement,
  countSql: SqlStatement,
  violation: Violation,
  bucket: CapacityBucket,
): SqlStatement =>
  sql`NOT EXISTS (
    SELECT 1
      FROM (VALUES ${dayDemandRows(bucket)}) AS dayDemand
     WHERE ${violation(
       sql`(${countSql}) + dayDemand.column3 + ${sqlLiteral(bucket.everyDay)}`,
       capSql,
     )}
  )`;

/** The cap a bucket is counted against, read from the table that holds it. A
 * listing carries a cap only while it is active, so the filter is part of the
 * subquery. */
const capSqlFor =
  (table: "listings" | "groups", activeFilter: SqlStatement) =>
  (id: number): SqlStatement =>
    sql`(SELECT max_attendees FROM ${sqlName(
      table,
    )} WHERE id = ${id}${activeFilter})`;

const listingCapSql = capSqlFor("listings", sql` AND active = 1`);

const groupCapSql = capSqlFor("groups", sql``);

/** One per-day clause builder per bucket kind: each brings its own cap, its
 * own counting subquery, and its own cap rule; the refusal shape is shared. */
const perDayClauseOf =
  (
    capSql: (id: number) => SqlStatement,
    countSql: (id: number) => SqlStatement,
    violation: Violation,
  ) =>
  (id: number, bucket: CapacityBucket): SqlStatement =>
    perDayClause(capSql(id), countSql(id), violation, bucket);

const listingPerDayClause = perDayClauseOf(
  listingCapSql,
  (id) =>
    buildListingCountSql({
      dayRange: DAY_RANGE,
      excludeAttendeeId: null,
      listingId: id,
    }),
  (overflow, cap) => sql`${cap} IS NULL OR ${overflow} > ${cap}`,
);

const groupPerDayClause = perDayClauseOf(
  groupCapSql,
  (id) => buildGroupCountSql(DAY_RANGE, null, id),
  (overflow, cap) => sql`${cap} > 0 AND ${overflow} > ${cap}`,
);

const LISTING_UNDATED = (id: number, bucket: CapacityBucket): SqlStatement =>
  undatedClause(
    buildListingCountSql({
      dayRange: null,
      excludeAttendeeId: null,
      listingId: id,
    }),
    listingCapSql(id),
    bucket,
  );

const GROUP_UNDATED = (id: number, bucket: CapacityBucket): SqlStatement =>
  sql`(${groupCapSql(id)} = 0 OR ${undatedClause(
    buildGroupCountSql(null, null, id),
    groupCapSql(id),
    bucket,
  )})`;

/** The undated clause for a bucket whose cart carries date-less demand:
 * `running total + the demand its last date-less line saw <= cap`. */
const undatedClause = (
  countSql: SqlStatement,
  capSql: SqlStatement,
  bucket: CapacityBucket,
): SqlStatement =>
  sql`(${countSql}) + ${sqlLiteral(bucket.throughLastUndated)} <= ${capSql}`;

const demandClauses = (
  demand: Map<number, CapacityBucket>,
  perDay: typeof listingPerDayClause,
  undated: typeof LISTING_UNDATED,
): SqlStatement[] =>
  [...demand].flatMap(([id, bucket]) => {
    if (bucket.perDay.size === 0 && !hasUndatedDemand(bucket)) return [];
    const clauses = bucket.perDay.size > 0 ? [perDay(id, bucket)] : [];
    if (!hasUndatedDemand(bucket)) return clauses;
    return [...clauses, undated(id, bucket)];
  });

/** A 1/0 expression: does this cart demand fit right now? */
const fitExpression = (demand: CartDemand): SqlStatement => {
  const clauses = [
    ...demandClauses(
      demand.listingDemand,
      listingPerDayClause,
      LISTING_UNDATED,
    ),
    ...demandClauses(demand.groupDemand, groupPerDayClause, GROUP_UNDATED),
  ];
  return clauses.length === 0
    ? sql`1`
    : sql`(${sqlJoin(clauses, sql` AND `)})`;
};

/** One SELECT returning `fits` (1/0): does this cart demand fit right now?
 * The checkout preflight asks once for the whole cart; a refusal diagnosis
 * asks write-order prefixes this way, one statement per sampled prefix in
 * one snapshot batch. Equal values share one slot, so listings booking the
 * same dates bind each day range once and the statement stays under SQLite's
 * variable-number cap. */
export const buildCartCapacitySql = (demand: CartDemand): SqlStatement =>
  sql`SELECT ${fitExpression(demand)} AS fits`;
