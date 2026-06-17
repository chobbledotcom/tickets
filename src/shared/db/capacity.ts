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

type CountSqlOptions = {
  dayRange: { startAt: string; endAt: string } | null;
  endAt: string | null;
  excludeArg: InValue[];
  excludeAttendeeId?: number;
  excludeEa2: string;
  excludeEa3: string;
  listingId: number;
  startAt: string | null;
};

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
export const dateToRange = (
  date: string,
  durationDays = 1,
): { startAt: string; endAt: string } => {
  const days = normalizeDurationDays(durationDays);
  const ms = new Date(`${date}T00:00:00Z`).getTime();
  const endIso = new Date(ms + days * 86_400_000).toISOString();
  return { endAt: endIso, startAt: `${date}T00:00:00Z` };
};

/**
 * Build a single-day capacity clause (listing-cap + group-cap when applicable).
 * `dayRange` is null for non-daily / date-less bookings; those use the editable
 * booked_quantity running total. Dated daily checks still count overlapping rows.
 */
const buildDayCapacitySql = (
  listingId: number,
  qty: number,
  dayRange: { startAt: string; endAt: string } | null,
  excludeAttendeeId?: number,
): SqlFragment => {
  const startAt = dayRange?.startAt ?? null;
  const endAt = dayRange?.endAt ?? null;
  const excludeEa2 = excludeAttendeeId ? "AND ea2.attendee_id != ? " : "";
  const excludeEa3 = excludeAttendeeId ? "AND ea3.attendee_id != ? " : "";
  const excludeArg: InValue[] = excludeAttendeeId ? [excludeAttendeeId] : [];
  const opts: CountSqlOptions = {
    dayRange,
    endAt,
    excludeArg,
    excludeAttendeeId,
    excludeEa2,
    excludeEa3,
    listingId,
    startAt,
  };
  const listingCount = buildListingCountSql(opts);
  const groupCount = buildGroupCountSql(opts);

  const sql = `(
    ${listingCount.sql}
  ) + ? <= (SELECT max_attendees FROM listings WHERE id = ?)
  AND (
    SELECT CASE
      WHEN ev.group_id = 0 THEN 1
      WHEN COALESCE(g.max_attendees, 0) = 0 THEN 1
      WHEN ${groupCount.sql} + ? <= g.max_attendees THEN 1
      ELSE 0
    END
    FROM listings ev
    LEFT JOIN groups g ON g.id = ev.group_id
    WHERE ev.id = ?
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

const buildListingCountSql = ({
  dayRange,
  endAt,
  excludeArg,
  excludeAttendeeId,
  excludeEa2,
  listingId,
  startAt,
}: CountSqlOptions): SqlFragment => {
  if (dayRange) {
    return {
      args: [listingId, ...excludeArg, endAt, startAt, listingId],
      sql: `(SELECT CASE
          WHEN e0.listing_type = 'daily' THEN (
            SELECT COALESCE(SUM(ea2.quantity), 0)
              FROM listing_attendees ea2
             WHERE ea2.listing_id = ? ${excludeEa2}
               AND ea2.start_at < ? AND ea2.end_at > ?
          )
          ELSE e0.booked_quantity
        END
        FROM listings e0 WHERE e0.id = ?)`,
    };
  }

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

const buildGroupCountSql = ({
  dayRange,
  endAt,
  excludeArg,
  excludeAttendeeId,
  excludeEa3,
  startAt,
}: CountSqlOptions): SqlFragment => {
  if (dayRange) {
    return {
      args: [
        ...(excludeAttendeeId ? [excludeAttendeeId] : []),
        ...excludeArg,
        endAt,
        startAt,
      ],
      sql: `(COALESCE((
          SELECT SUM(e2.booked_quantity)
            FROM listings e2
           WHERE e2.group_id = ev.group_id AND e2.listing_type != 'daily'
        ), 0)
        ${
          excludeAttendeeId
            ? `- COALESCE((
          SELECT SUM(ea4.quantity)
            FROM listing_attendees ea4
            JOIN listings e4 ON e4.id = ea4.listing_id
           WHERE e4.group_id = ev.group_id
             AND e4.listing_type != 'daily'
             AND ea4.attendee_id = ?
        ), 0)`
            : ""
        }
        + COALESCE((
          SELECT SUM(ea3.quantity)
            FROM listing_attendees ea3
            JOIN listings e3 ON e3.id = ea3.listing_id
           WHERE e3.group_id = ev.group_id
             AND e3.listing_type = 'daily' ${excludeEa3}
             AND ea3.start_at < ? AND ea3.end_at > ?
        ), 0))`,
    };
  }

  return {
    args: excludeArg,
    sql: `(COALESCE((
          SELECT SUM(e2.booked_quantity)
            FROM listings e2
           WHERE e2.group_id = ev.group_id
        ), 0)
        ${
          excludeAttendeeId
            ? `- COALESCE((
          SELECT SUM(ea3.quantity)
            FROM listing_attendees ea3
            JOIN listings e3 ON e3.id = ea3.listing_id
           WHERE e3.group_id = ev.group_id AND ea3.attendee_id = ?
        ), 0)`
            : ""
        })`,
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
