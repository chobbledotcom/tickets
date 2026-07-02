/**
 * SQL builders for listing capacity checks.
 *
 * The WHERE clause produced by `buildCapacityCondition` is embedded inside
 * atomic INSERT/UPDATE statements on `listing_attendees` so that capacity is
 * enforced in the same statement that mutates the row (no read-modify-write
 * race).
 *
 * Multi-day daily bookings emit one clause per day, AND'd together, so the
 * SQL safety-net matches the per-day accuracy of the JS preflight. Range
 * length is bounded (≤90 via form validation) so the SQL stays cheap.
 */

import type { InValue } from "@libsql/client";
import { addDays } from "#shared/dates.ts";
import { normalizeDurationDays } from "#shared/types.ts";

export type SqlFragment = { sql: string; args: InValue[] };
type DayRange = { startAt: string; endAt: string };

/** Convert a date string ("YYYY-MM-DD") to a half-open [start, end) pair.
 * `durationDays` is normalized (whole days in [1, MAX]) so `end_at` is always
 * a clean midnight boundary N full days after start — the stored range and
 * every capacity check derive their span the same way.
 *
 * Format note: `startAt` is `"…T00:00:00Z"` (template literal); `endAt`
 * is `"…T00:00:00.000Z"` (Date.toISOString). The overlap predicate
 * `start_at < endAt AND end_at > startAt` is strict-less/strict-greater,
 * so the `.000Z` / `Z` difference is irrelevant — but do not "tidy" them
 * to match, because SQLite TEXT comparison is byte-for-byte and tests
 * assert the exact stored format. */
export const dateToRange = (date: string, durationDays = 1): DayRange => {
  const days = normalizeDurationDays(durationDays);
  const ms = new Date(`${date}T00:00:00Z`).getTime();
  const endIso = new Date(ms + days * 86_400_000).toISOString();
  return { endAt: endIso, startAt: `${date}T00:00:00Z` };
};

const attendeeExclusionSql = (
  alias: string,
  excludeAttendeeId?: number,
): string => (excludeAttendeeId ? `AND ${alias}.attendee_id != ? ` : "");

const attendeeExclusionArgs = (excludeAttendeeId?: number): InValue[] =>
  excludeAttendeeId ? [excludeAttendeeId] : [];

const buildDailyListingCountSql = (
  listingId: number,
  dayRange: DayRange,
  excludeAttendeeId?: number,
): SqlFragment => ({
  args: [
    listingId,
    ...attendeeExclusionArgs(excludeAttendeeId),
    dayRange.endAt,
    dayRange.startAt,
    listingId,
  ],
  sql: `(SELECT CASE
          WHEN listing.listing_type = 'daily' THEN (
            SELECT COALESCE(SUM(attendee.quantity), 0)
              FROM listing_attendees AS attendee
             WHERE attendee.listing_id = ? ${attendeeExclusionSql(
               "attendee",
               excludeAttendeeId,
             )}
               AND attendee.start_at < ? AND attendee.end_at > ?
          )
          ELSE listing.booked_quantity
        END
        FROM listings AS listing WHERE listing.id = ?)`,
});

const buildUndatedListingCountSql = (
  listingId: number,
  excludeAttendeeId?: number,
): SqlFragment => {
  if (excludeAttendeeId) {
    return {
      args: [listingId, listingId, excludeAttendeeId],
      sql: `((SELECT booked_quantity FROM listings WHERE id = ?)
          - COALESCE((
            SELECT SUM(attendee.quantity)
              FROM listing_attendees AS attendee
             WHERE attendee.listing_id = ? AND attendee.attendee_id = ?
          ), 0))`,
    };
  }

  return {
    args: [listingId],
    sql: "(SELECT booked_quantity FROM listings WHERE id = ?)",
  };
};

/** The count subquery for one listing — daily listings count overlapping rows
 * for the day, others read the running `booked_quantity`. Exported so the batch
 * read preflight ({@link buildBatchCapacitySql}) counts a listing the SAME way
 * the atomic write predicate does. */
export const buildListingCountSql = (
  listingId: number,
  dayRange: DayRange | null,
  excludeAttendeeId?: number,
): SqlFragment => {
  if (dayRange) {
    return buildDailyListingCountSql(listingId, dayRange, excludeAttendeeId);
  }

  return buildUndatedListingCountSql(listingId, excludeAttendeeId);
};

// The group-count subqueries below correlate on `groupRow.id` — the group row
// of the enclosing NOT EXISTS in buildDayCapacitySql — and reach that group's member
// listings through the group_listings join table, so a listing that belongs to
// several groups is counted against each group's cap independently.

const buildDailyNonListingGroupExclusionSql = (
  excludeAttendeeId?: number,
): string => {
  if (!excludeAttendeeId) return "";

  return `- COALESCE((
          SELECT SUM(attendee.quantity)
            FROM listing_attendees AS attendee
            JOIN group_listings AS groupListing
              ON groupListing.listing_id = attendee.listing_id
            JOIN listings AS memberListing
              ON memberListing.id = attendee.listing_id
           WHERE groupListing.group_id = groupRow.id
             AND memberListing.listing_type != 'daily'
             AND attendee.attendee_id = ?
        ), 0)`;
};

const buildUndatedGroupExclusionSql = (excludeAttendeeId?: number): string => {
  if (!excludeAttendeeId) return "";

  return `- COALESCE((
          SELECT SUM(attendee.quantity)
            FROM listing_attendees AS attendee
            JOIN group_listings AS groupListing
              ON groupListing.listing_id = attendee.listing_id
           WHERE groupListing.group_id = groupRow.id
             AND attendee.attendee_id = ?
        ), 0)`;
};

// `groupRef` names the group whose members are summed: "groupRow.id" correlates
// on the enclosing NOT EXISTS row (the write predicate), while the batch read
// preflight passes a literal group id. The COUNTING body is otherwise identical,
// so the write guard and the read preflight can never count a group differently.
// (Self-exclusion is write-only — the batch never excludes — so those branches
// keep the correlated "groupRow.id" they are only ever emitted with.)
const buildDailyGroupCountSql = (
  dayRange: DayRange,
  excludeAttendeeId?: number,
  groupRef = "groupRow.id",
): SqlFragment => ({
  args: [
    ...attendeeExclusionArgs(excludeAttendeeId),
    ...attendeeExclusionArgs(excludeAttendeeId),
    dayRange.endAt,
    dayRange.startAt,
  ],
  sql: `(COALESCE((
          SELECT SUM(memberListing.booked_quantity)
            FROM listings AS memberListing
            JOIN group_listings AS groupListing
              ON groupListing.listing_id = memberListing.id
           WHERE groupListing.group_id = ${groupRef}
             AND memberListing.listing_type != 'daily'
        ), 0)
        ${buildDailyNonListingGroupExclusionSql(excludeAttendeeId)}
        + COALESCE((
          SELECT SUM(attendee.quantity)
            FROM listing_attendees AS attendee
            JOIN group_listings AS groupListing
              ON groupListing.listing_id = attendee.listing_id
            JOIN listings AS memberListing
              ON memberListing.id = attendee.listing_id
           WHERE groupListing.group_id = ${groupRef}
             AND memberListing.listing_type = 'daily' ${attendeeExclusionSql(
               "attendee",
               excludeAttendeeId,
             )}
             AND attendee.start_at < ? AND attendee.end_at > ?
        ), 0))`,
});

const buildUndatedGroupCountSql = (
  excludeAttendeeId?: number,
  groupRef = "groupRow.id",
): SqlFragment => ({
  args: attendeeExclusionArgs(excludeAttendeeId),
  sql: `(COALESCE((
          SELECT SUM(memberListing.booked_quantity)
            FROM listings AS memberListing
            JOIN group_listings AS groupListing
              ON groupListing.listing_id = memberListing.id
           WHERE groupListing.group_id = ${groupRef}
        ), 0)
        ${buildUndatedGroupExclusionSql(excludeAttendeeId)})`,
});

const buildGroupCountSql = (
  dayRange: DayRange | null,
  excludeAttendeeId?: number,
  groupRef = "groupRow.id",
): SqlFragment => {
  if (dayRange) {
    return buildDailyGroupCountSql(dayRange, excludeAttendeeId, groupRef);
  }

  return buildUndatedGroupCountSql(excludeAttendeeId, groupRef);
};

/**
 * Build a single-day capacity clause (listing-cap + group-cap when applicable).
 * `dayRange` is null for non-daily / date-less bookings; those use the editable
 * booked_quantity running total. Dated daily checks still count overlapping rows.
 */
const buildDayCapacitySql = (
  listingId: number,
  qty: number,
  dayRange: DayRange | null,
  excludeAttendeeId?: number,
): SqlFragment => {
  const listingCount = buildListingCountSql(
    listingId,
    dayRange,
    excludeAttendeeId,
  );
  const groupCount = buildGroupCountSql(dayRange, excludeAttendeeId);

  // The listing-cap line also enforces active = 1 (an inactive listing's
  // max_attendees subquery is NULL, so the comparison fails). The group cap
  // passes unless SOME group the listing belongs to is capped and would be
  // pushed over by this booking — so an ungrouped or all-uncapped listing has
  // no offending group and NOT EXISTS is satisfied.
  const sql = `(
    ${listingCount.sql}
  ) + ? <= (SELECT max_attendees FROM listings WHERE id = ? AND active = 1)
  AND NOT EXISTS (
    SELECT 1
    FROM group_listings AS groupListing
    JOIN groups AS groupRow ON groupRow.id = groupListing.group_id
    WHERE groupListing.listing_id = ?
      AND groupRow.max_attendees > 0
      AND (${groupCount.sql}) + ? > groupRow.max_attendees
  )`;

  return {
    args: [
      ...listingCount.args,
      qty,
      listingId,
      listingId,
      ...groupCount.args,
      qty,
    ],
    sql,
  };
};

/**
 * Build the WHERE clause for capacity checking on listing_attendees.
 * For multi-day daily bookings, emits one clause per day AND'd together so
 * the atomic SQL guard matches the per-day accuracy of the JS preflight.
 *
 * @param excludeAttendeeId - If set, excludes this attendee's rows from the count (for updates)
 */
export const buildCapacityCondition = (
  listingId: number,
  qty: number,
  date: string | null,
  excludeAttendeeId?: number,
  durationDays = 1,
): SqlFragment => {
  if (!date) {
    return buildDayCapacitySql(listingId, qty, null, excludeAttendeeId);
  }
  const duration = normalizeDurationDays(durationDays);
  const clauses: string[] = [];
  const args: InValue[] = [];
  for (let i = 0; i < duration; i++) {
    const daily = buildDayCapacitySql(
      listingId,
      qty,
      dateToRange(addDays(date, i), 1),
      excludeAttendeeId,
    );
    clauses.push(`(${daily.sql})`);
    args.push(...daily.args);
  }
  return { args, sql: clauses.join(" AND ") };
};

/** One listing's or one group's cart demand, split into per-day (dated daily)
 * buckets and a date-less `total` — the shape the batch read aggregates. */
export type CapacityBucket = { perDay: Map<string, number>; total: number };

/** A `<= cap` clause for one listing's demand against its OWN cap, reusing the
 * same count subquery the write predicate uses. `active = 1` matches the write
 * (an inactive listing's cap is NULL, so the clause — and the AND — is NULL,
 * which the enclosing CASE resolves to "not available"). */
const listingCapClause = (
  listingId: number,
  dayRange: DayRange | null,
  demand: number,
): SqlFragment => {
  const count = buildListingCountSql(listingId, dayRange);
  return {
    args: count.args,
    sql: `((${count.sql}) + ${demand} <= (SELECT max_attendees FROM listings WHERE id = ${listingId} AND active = 1))`,
  };
};

/** A `<= cap` clause for one group's demand against its cap, reusing the write
 * predicate's group count subquery. An uncapped group (`max_attendees = 0`)
 * always passes, matching the write's `max_attendees > 0` gate. */
const groupCapClause = (
  groupId: number,
  dayRange: DayRange | null,
  demand: number,
): SqlFragment => {
  const count = buildGroupCountSql(dayRange, undefined, String(groupId));
  const cap = `(SELECT max_attendees FROM groups WHERE id = ${groupId})`;
  return {
    args: count.args,
    sql: `(${cap} = 0 OR (${count.sql}) + ${demand} <= ${cap})`,
  };
};

/** Append the clauses for one demand bucket. Daily (per-day) demand emits one
 * clause per day; a date-less bucket emits a single total clause. `extra` is
 * added to every day's demand — the group case folds its non-daily cart demand
 * into each day, since those units occupy the group on every date too. */
const bucketClauses = (
  bucket: CapacityBucket,
  extra: number,
  clauseFor: (dayRange: DayRange | null, demand: number) => SqlFragment,
): SqlFragment[] => {
  if (bucket.perDay.size > 0) {
    return [...bucket.perDay].map(([day, qty]) =>
      clauseFor(dateToRange(day), qty + extra),
    );
  }
  return bucket.total > 0 ? [clauseFor(null, bucket.total)] : [];
};

/**
 * One SELECT returning `fits` (1/0) for a whole cart's combined demand, built
 * from the SAME listing/group count subqueries the atomic write predicate uses
 * — so the read-time preflight and the write-time guard can never count
 * capacity differently. Listing demand is checked per listing; group demand is
 * checked per group with the cart's non-daily demand folded into each day.
 */
export const buildBatchCapacitySql = (
  listingDemand: Map<number, CapacityBucket>,
  groupDemand: Map<number, CapacityBucket>,
): SqlFragment => {
  const clauses: SqlFragment[] = [];
  for (const [listingId, bucket] of listingDemand) {
    clauses.push(
      ...bucketClauses(bucket, 0, (dayRange, demand) =>
        listingCapClause(listingId, dayRange, demand),
      ),
    );
  }
  for (const [groupId, bucket] of groupDemand) {
    clauses.push(
      ...bucketClauses(bucket, bucket.total, (dayRange, demand) =>
        groupCapClause(groupId, dayRange, demand),
      ),
    );
  }
  if (clauses.length === 0) return { args: [], sql: "SELECT 1 AS fits" };
  return {
    args: clauses.flatMap((c) => c.args),
    sql: `SELECT CASE WHEN ${clauses
      .map((c) => c.sql)
      .join(" AND ")} THEN 1 ELSE 0 END AS fits`,
  };
};
