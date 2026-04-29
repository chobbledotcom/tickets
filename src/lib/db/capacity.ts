/**
 * SQL builders for event capacity checks.
 *
 * The WHERE clause produced by `buildCapacityCondition` is embedded inside
 * atomic INSERT/UPDATE statements on `event_attendees` so that capacity is
 * enforced in the same statement that mutates the row (no read-modify-write
 * race). It currently handles the single-day case: for daily events we overlap
 * on `start_at`/`end_at` derived from the booking date.
 */

import type { InValue } from "@libsql/client";

/** A reusable SQL fragment with its positional bind arguments. */
export type SqlFragment = { sql: string; args: InValue[] };

/** Convert a date string ("YYYY-MM-DD") to start_at/end_at pair for full-day range */
export const dateToRange = (
  date: string,
): { startAt: string; endAt: string } => {
  const ms = new Date(`${date}T00:00:00Z`).getTime();
  const nextDay = new Date(ms + 86_400_000).toISOString();
  return { endAt: nextDay, startAt: `${date}T00:00:00Z` };
};

/**
 * SQL fragment deciding whether an `event_attendees` row counts toward a
 * group's used capacity for a given date.
 *
 *   - Standard events always count.
 *   - Daily events count only when their booking overlaps the date.
 *   - When `date` is null, every row counts — callers that want per-date
 *     scope pass a non-null date upstream.
 *
 * Used by both the booking-time SQL in `buildCapacityCondition` and the
 * read-side SQL in `getGroupRemainingByGroupId` so the two never drift.
 *
 * Produces `(? IS NULL OR <eventAlias>.event_type != 'daily' OR
 * (<attendeeAlias>.start_at < ? AND <attendeeAlias>.end_at > ?))` plus its
 * three positional args `[date, endAt, startAt]`.
 */
export const buildGroupAttendeePredicate = (
  eventAlias: string,
  attendeeAlias: string,
  date: string | null,
): SqlFragment => {
  const range = date ? dateToRange(date) : null;
  return {
    args: [date, range?.endAt ?? null, range?.startAt ?? null],
    sql: `(? IS NULL OR ${eventAlias}.event_type != 'daily' OR (${attendeeAlias}.start_at < ? AND ${attendeeAlias}.end_at > ?))`,
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
): SqlFragment => {
  const range = date ? dateToRange(date) : null;
  const endAt = range?.endAt ?? null;
  const startAt = range?.startAt ?? null;

  const excludeClause = excludeAttendeeId ? " AND ea2.attendee_id != ?" : "";
  const capacityFilter = date
    ? `SELECT COALESCE(SUM(ea2.quantity), 0) FROM event_attendees ea2 WHERE ea2.event_id = ?${excludeClause} AND ea2.start_at < ? AND ea2.end_at > ?`
    : `SELECT COALESCE(SUM(ea2.quantity), 0) FROM event_attendees ea2 WHERE ea2.event_id = ?${excludeClause}`;
  const capacityArgs: InValue[] = date
    ? excludeAttendeeId
      ? [eventId, excludeAttendeeId, endAt, startAt]
      : [eventId, endAt, startAt]
    : excludeAttendeeId
      ? [eventId, excludeAttendeeId]
      : [eventId];

  const groupExclude = excludeAttendeeId
    ? "AND ea3.attendee_id != ?\n                  "
    : "";
  const groupPredicate = buildGroupAttendeePredicate("e2", "ea3", date);
  const groupCapacityCheck = `
          AND (
            SELECT CASE
              WHEN ev.group_id = 0 THEN 1
              WHEN COALESCE(g.max_attendees, 0) = 0 THEN 1
              WHEN (
                SELECT COALESCE(SUM(ea3.quantity), 0)
                FROM event_attendees ea3
                JOIN events e2 ON e2.id = ea3.event_id
                WHERE e2.group_id = ev.group_id
                  ${groupExclude}AND ${groupPredicate.sql}
              ) + ? <= g.max_attendees THEN 1
              ELSE 0
            END
            FROM events ev
            LEFT JOIN groups g ON g.id = ev.group_id
            WHERE ev.id = ?
          ) = 1`;
  const groupCapacityArgs: InValue[] = excludeAttendeeId
    ? [excludeAttendeeId, ...groupPredicate.args, qty, eventId]
    : [...groupPredicate.args, qty, eventId];

  return {
    args: [...capacityArgs, qty, eventId, ...groupCapacityArgs],
    sql: `(${capacityFilter}) + ? <= (SELECT max_attendees FROM events WHERE id = ?)${groupCapacityCheck}`,
  };
};
