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
            SELECT COALESCE(SUM(ea2.quantity), 0)
              FROM listing_attendees ea2
             WHERE ea2.listing_id = ? ${attendeeExclusionSql(
               "ea2",
               excludeAttendeeId,
             )}
               AND ea2.start_at < ? AND ea2.end_at > ?
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
            SELECT SUM(ea2.quantity)
              FROM listing_attendees ea2
             WHERE ea2.listing_id = ? AND ea2.attendee_id = ?
          ), 0))`,
    };
  }

  return {
    args: [listingId],
    sql: "(SELECT booked_quantity FROM listings WHERE id = ?)",
  };
};

const buildListingCountSql = (
  listingId: number,
  dayRange: DayRange | null,
  excludeAttendeeId?: number,
): SqlFragment => {
  if (dayRange) {
    return buildDailyListingCountSql(listingId, dayRange, excludeAttendeeId);
  }

  return buildUndatedListingCountSql(listingId, excludeAttendeeId);
};

const buildDailyNonListingGroupExclusionSql = (
  excludeAttendeeId?: number,
): string => {
  if (!excludeAttendeeId) return "";

  return `- COALESCE((
          SELECT SUM(ea4.quantity)
            FROM listing_attendees ea4
            JOIN listings AS groupListing ON groupListing.id = ea4.listing_id
           WHERE groupListing.group_id = listing.group_id
             AND groupListing.listing_type != 'daily'
             AND ea4.attendee_id = ?
        ), 0)`;
};

const buildUndatedGroupExclusionSql = (excludeAttendeeId?: number): string => {
  if (!excludeAttendeeId) return "";

  return `- COALESCE((
          SELECT SUM(ea3.quantity)
            FROM listing_attendees ea3
            JOIN listings AS groupListing ON groupListing.id = ea3.listing_id
           WHERE groupListing.group_id = listing.group_id AND ea3.attendee_id = ?
        ), 0)`;
};

const buildDailyGroupCountSql = (
  dayRange: DayRange,
  excludeAttendeeId?: number,
): SqlFragment => ({
  args: [
    ...attendeeExclusionArgs(excludeAttendeeId),
    ...attendeeExclusionArgs(excludeAttendeeId),
    dayRange.endAt,
    dayRange.startAt,
  ],
  sql: `(COALESCE((
          SELECT SUM(groupListing.booked_quantity)
            FROM listings AS groupListing
           WHERE groupListing.group_id = listing.group_id AND groupListing.listing_type != 'daily'
        ), 0)
        ${buildDailyNonListingGroupExclusionSql(excludeAttendeeId)}
        + COALESCE((
          SELECT SUM(ea3.quantity)
            FROM listing_attendees ea3
            JOIN listings AS groupListing ON groupListing.id = ea3.listing_id
           WHERE groupListing.group_id = listing.group_id
             AND groupListing.listing_type = 'daily' ${attendeeExclusionSql(
               "ea3",
               excludeAttendeeId,
             )}
             AND ea3.start_at < ? AND ea3.end_at > ?
        ), 0))`,
});

const buildUndatedGroupCountSql = (
  excludeAttendeeId?: number,
): SqlFragment => ({
  args: attendeeExclusionArgs(excludeAttendeeId),
  sql: `(COALESCE((
          SELECT SUM(groupListing.booked_quantity)
            FROM listings AS groupListing
           WHERE groupListing.group_id = listing.group_id
        ), 0)
        ${buildUndatedGroupExclusionSql(excludeAttendeeId)})`,
});

const buildGroupCountSql = (
  dayRange: DayRange | null,
  excludeAttendeeId?: number,
): SqlFragment => {
  if (dayRange) {
    return buildDailyGroupCountSql(dayRange, excludeAttendeeId);
  }

  return buildUndatedGroupCountSql(excludeAttendeeId);
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

  const sql = `(
    ${listingCount.sql}
  ) + ? <= (SELECT max_attendees FROM listings WHERE id = ? AND active = 1)
  AND (
    SELECT CASE
      WHEN listing.group_id = 0 THEN 1
      WHEN COALESCE(g.max_attendees, 0) = 0 THEN 1
      WHEN ${groupCount.sql} + ? <= g.max_attendees THEN 1
      ELSE 0
    END
    FROM listings AS listing
    LEFT JOIN groups g ON g.id = listing.group_id
    WHERE listing.id = ? AND listing.active = 1
  ) = 1`;

  return {
    args: [
      ...listingCount.args,
      qty,
      listingId,
      ...groupCount.args,
      qty,
      listingId,
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
