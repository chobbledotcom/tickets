/**
 * SQL builders for event capacity checks.
 *
 * The WHERE clause produced by `buildCapacityCondition` is embedded inside
 * atomic INSERT/UPDATE statements on `event_attendees` so that capacity is
 * enforced in the same statement that mutates the row (no read-modify-write
 * race).
 *
 * Multi-day daily bookings emit one clause per day, AND'd together, so the
 * SQL safety-net matches the per-day accuracy of the JS preflight. Range
 * length is bounded (≤90 via form validation) so the SQL stays cheap.
 */

import type { InValue } from "@libsql/client";

/** Add N calendar days to a YYYY-MM-DD date string (UTC-based). */
export const addDaysStr = (dateStr: string, days: number): string => {
  const date = new Date(`${dateStr}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

/** Convert a date string ("YYYY-MM-DD") to a half-open [start, end) pair.
 * With `durationDays > 1` the range spans multiple calendar days. */
export const dateToRange = (
  date: string,
  durationDays = 1,
): { startAt: string; endAt: string } => {
  const ms = new Date(`${date}T00:00:00Z`).getTime();
  const endIso = new Date(ms + durationDays * 86_400_000).toISOString();
  return { endAt: endIso, startAt: `${date}T00:00:00Z` };
};

/**
 * Build a single-day capacity clause (event-cap + group-cap when applicable).
 * `dayRange` is null for non-daily / date-less bookings; uses `? IS NULL OR …`
 * to elide the time filter in one branch rather than two SQL shapes.
 */
const buildDayCapacitySql = (
  eventId: number,
  qty: number,
  dayRange: { startAt: string; endAt: string } | null,
  excludeAttendeeId?: number,
): { sql: string; args: InValue[] } => {
  const dayDate = dayRange?.startAt.slice(0, 10) ?? null;
  const startAt = dayRange?.startAt ?? null;
  const endAt = dayRange?.endAt ?? null;
  const excludeEa2 = excludeAttendeeId ? "AND ea2.attendee_id != ? " : "";
  const excludeEa3 = excludeAttendeeId ? "AND ea3.attendee_id != ? " : "";
  const excludeArg: InValue[] = excludeAttendeeId ? [excludeAttendeeId] : [];

  const sql = `(
    SELECT COALESCE(SUM(ea2.quantity), 0)
    FROM event_attendees ea2
    WHERE ea2.event_id = ? ${excludeEa2}
    AND (? IS NULL OR (ea2.start_at < ? AND ea2.end_at > ?))
  ) + ? <= (SELECT max_attendees FROM events WHERE id = ?)
  AND (
    SELECT CASE
      WHEN ev.group_id = 0 THEN 1
      WHEN COALESCE(g.max_attendees, 0) = 0 THEN 1
      WHEN (
        SELECT COALESCE(SUM(ea3.quantity), 0)
        FROM event_attendees ea3
        JOIN events e2 ON e2.id = ea3.event_id
        WHERE e2.group_id = ev.group_id ${excludeEa3}
        AND (? IS NULL OR e2.event_type != 'daily' OR (ea3.start_at < ? AND ea3.end_at > ?))
      ) + ? <= g.max_attendees THEN 1
      ELSE 0
    END
    FROM events ev
    LEFT JOIN groups g ON g.id = ev.group_id
    WHERE ev.id = ?
  ) = 1`;

  return {
    args: [
      eventId,
      ...excludeArg,
      startAt,
      endAt,
      startAt,
      qty,
      eventId,
      ...excludeArg,
      dayDate,
      endAt,
      startAt,
      qty,
      eventId,
    ],
    sql,
  };
};

/**
 * Build the WHERE clause for capacity checking on event_attendees.
 * @param excludeAttendeeId - If set, excludes this attendee's rows from the count (for updates)
 */
export const buildCapacityCondition = (
  eventId: number,
  qty: number,
  date: string | null,
  excludeAttendeeId?: number,
  durationDays = 1,
): { sql: string; args: InValue[] } => {
  if (!date) return buildDayCapacitySql(eventId, qty, null, excludeAttendeeId);
  const duration = Math.max(1, Math.floor(durationDays));
  const clauses: string[] = [];
  const args: InValue[] = [];
  for (let i = 0; i < duration; i++) {
    const daily = buildDayCapacitySql(
      eventId,
      qty,
      dateToRange(addDaysStr(date, i), 1),
      excludeAttendeeId,
    );
    clauses.push(`(${daily.sql})`);
    args.push(...daily.args);
  }
  return { args, sql: clauses.join(" AND ") };
};
