/**
 * The cart read preflight's SQL: whether a whole cart's demand fits right now.
 * It reuses the write predicate's counting subqueries from `#db/capacity.ts`,
 * so the read-time preflight and the write-time guard can never count
 * capacity differently.
 *
 * One clause per listing and per group, whatever the day count. Each clause
 * carries the bucket's per-day demands as a VALUES table, so a cart of 12
 * daily lines at the 90-day maximum stays far under SQLite's expression-depth
 * limit instead of emitting 1080 ANDed clauses.
 */

import {
  buildGroupCountSql,
  buildListingCountSql,
  type DayRange,
  dateToRange,
} from "#db/capacity.ts";
import type { SqlStatement } from "#db/client.ts";
import {
  numberedStatement,
  type SqlParameter,
  type SqlParameterToken,
} from "#db/numbered-statement.ts";

/** One listing's or one group's cart demand. `perDay` holds the dated demand
 * on per-date counting listings, keyed by day. `everyDay` holds demand that
 * occupies the cap on every date too — lines on date-less-cap listings, whose
 * running total every statement counts. `undatedOnly` holds date-less lines
 * on per-date listings, which no dated statement of the write can ever see:
 * only the undated clause counts them. */
export type CapacityBucket = {
  everyDay: number;
  perDay: Map<string, number>;
  undatedOnly: number;
};

/** One cart's whole demand, listing buckets beside group buckets. */
export type CartDemand = {
  groupDemand: Map<number, CapacityBucket>;
  listingDemand: Map<number, CapacityBucket>;
};

/** A bucket's total demand — the undated clauses count the whole prefix,
 * because the write's aggregate trigger bumps the running total for every
 * line it inserts, whatever its date. */
const wholeBucket = (bucket: CapacityBucket): number =>
  bucket.everyDay +
  bucket.undatedOnly +
  [...bucket.perDay.values()].reduce((sum, qty) => sum + qty, 0);

const hasUndatedDemand = (bucket: CapacityBucket): boolean =>
  bucket.everyDay > 0 || bucket.undatedOnly > 0;

/** The bucket's per-day rows as VALUES tuples of (start_at, end_at, qty). The
 * demand quantity stays a literal: it is a non-negative cart total, never
 * user-typed text. */
const dayDemandRows = (bucket: CapacityBucket, bind: SqlParameter): string =>
  [...bucket.perDay]
    .map(([day, qty]) => {
      const { endAt, startAt } = dateToRange(day);
      return `(${bind(startAt)}, ${bind(endAt)}, ${qty})`;
    })
    .join(", ");

const DAY_RANGE: DayRange = {
  endAt: "dayDemand.column2",
  startAt: "dayDemand.column1",
};

/** Refuse when any single day's occupancy plus that day's cart demand, on
 * top of the demand every date carries, breaks the cap. `violation` is the
 * per-kind cap rule: a listing refuses on a NULL cap (the write's inactive
 * listing refusal), a group passes an uncapped cap of 0 (the write's
 * `max_attendees > 0` gate). */
const perDayClause = (
  capSql: string,
  countSql: string,
  violation: (overflow: string, cap: string) => string,
  bucket: CapacityBucket,
  bind: SqlParameter,
): string => `NOT EXISTS (
    SELECT 1
      FROM (VALUES ${dayDemandRows(bucket, bind)}) AS dayDemand
     WHERE ${violation(`(${countSql}) + dayDemand.column3 + ${bucket.everyDay}`, capSql)}
  )`;

const listingCapSql = (idSql: SqlParameterToken): string =>
  `(SELECT max_attendees FROM listings WHERE id = ${idSql} AND active = 1)`;

const groupCapSql = (idSql: SqlParameterToken): string =>
  `(SELECT max_attendees FROM groups WHERE id = ${idSql})`;

/** One per-day clause builder per bucket kind: each brings its own cap, its
 * own counting subquery, and its own cap rule; the refusal shape is shared. */
const perDayClauseOf =
  (
    capSql: (idSql: SqlParameterToken) => string,
    countSql: (idSql: SqlParameterToken) => string,
    violation: (overflow: string, cap: string) => string,
  ) =>
  (
    idSql: SqlParameterToken,
    bucket: CapacityBucket,
    bind: SqlParameter,
  ): string =>
    perDayClause(capSql(idSql), countSql(idSql), violation, bucket, bind);

const listingPerDayClause = perDayClauseOf(
  listingCapSql,
  (idSql) =>
    buildListingCountSql({
      dayRange: DAY_RANGE,
      excludeAttendeeId: null,
      listingId: idSql,
    }),
  (overflow, cap) => `${cap} IS NULL OR ${overflow} > ${cap}`,
);

const groupPerDayClause = perDayClauseOf(
  groupCapSql,
  (idSql) => buildGroupCountSql(DAY_RANGE, null, idSql),
  (overflow, cap) => `${cap} > 0 AND ${overflow} > ${cap}`,
);

const LISTING_UNDATED = (
  idSql: SqlParameterToken,
  bucket: CapacityBucket,
): string =>
  undatedClause(
    buildListingCountSql({
      dayRange: null,
      excludeAttendeeId: null,
      listingId: idSql,
    }),
    listingCapSql(idSql),
    bucket,
  );

const GROUP_UNDATED = (
  idSql: SqlParameterToken,
  bucket: CapacityBucket,
): string =>
  `(${groupCapSql(idSql)} = 0 OR ${undatedClause(
    buildGroupCountSql(null, null, idSql),
    groupCapSql(idSql),
    bucket,
  )})`;

/** The undated clause for a bucket whose cart carries date-less demand:
 * `running total + the whole bucket <= cap`. */
const undatedClause = (
  countSql: string,
  capSql: string,
  bucket: CapacityBucket,
): string => `(${countSql}) + ${wholeBucket(bucket)} <= ${capSql}`;

const demandClauses = (
  demand: Map<number, CapacityBucket>,
  bind: SqlParameter,
  perDay: typeof listingPerDayClause,
  undated: typeof LISTING_UNDATED,
): string[] =>
  [...demand].flatMap(([id, bucket]) => {
    if (bucket.perDay.size === 0 && !hasUndatedDemand(bucket)) return [];
    // The id binds on the bucket's first clause, so an empty bucket binds none.
    const idSql = bind(id);
    const clauses = bucket.perDay.size > 0 ? [perDay(idSql, bucket, bind)] : [];
    if (!hasUndatedDemand(bucket)) return clauses;
    return [...clauses, undated(idSql, bucket)];
  });

/** A 1/0 expression: does this cart demand fit right now? */
const fitExpression = (demand: CartDemand, bind: SqlParameter): string => {
  const clauses = [
    ...demandClauses(
      demand.listingDemand,
      bind,
      listingPerDayClause,
      LISTING_UNDATED,
    ),
    ...demandClauses(
      demand.groupDemand,
      bind,
      groupPerDayClause,
      GROUP_UNDATED,
    ),
  ];
  return clauses.length === 0
    ? "1"
    : `CASE WHEN ${clauses.join(" AND ")} THEN 1 ELSE 0 END`;
};

/** One SELECT returning `fits` (1/0) for a whole cart's combined demand. */
export const buildBatchCapacitySql = (
  listingDemand: Map<number, CapacityBucket>,
  groupDemand: Map<number, CapacityBucket>,
): SqlStatement =>
  numberedStatement(
    (bind) =>
      `SELECT ${fitExpression({ groupDemand, listingDemand }, bind)} AS fits`,
  );

/** One SELECT answering several cart demands at once — `fit0`, `fit1`, … each
 * 1/0. A refusal diagnosis asks every prefix of an order this way, so its
 * cost stays one query however long the order is. */
export const buildManyFitsSql = (demands: CartDemand[]): SqlStatement => {
  if (demands.length === 0) {
    throw new Error("A fits query needs at least one cart demand");
  }
  return numberedStatement(
    (bind) =>
      `SELECT ${demands
        .map(
          (demand, index) => `(${fitExpression(demand, bind)}) AS fit${index}`,
        )
        .join(", ")}`,
  );
};
