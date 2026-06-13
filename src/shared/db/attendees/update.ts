/**
 * Update operations for attendees and their per-event bookings.
 */

import { filter, map, pipe, reduce, sort, unique } from "#fp";
import { normalizeDurationDays } from "#shared/types.ts";
import type {
  EventBooking,
  UpdateAttendeePIIInput,
  UpdateEventLinkInput,
  UpdateEventLinkResult,
} from "#shared/db/attendee-types.ts";
import {
  buildCapacityCheckedInsert,
  checkCapacityResult,
  dateToStartEnd,
} from "#shared/db/attendees/capacity.ts";
import { buildPiiBlob, encryptPiiBlob } from "#shared/db/attendees/pii.ts";
import { buildCapacityCondition } from "#shared/db/capacity.ts";
import { getDb, queryAll } from "#shared/db/client.ts";
import { invalidateEventsCache } from "#shared/db/events.ts";
import { settings } from "#shared/db/settings.ts";

/** Update a per-event status field on event_attendees */
const updateEventAttendeeField =
  (field: string) =>
  async (attendeeId: number, eventId: number, value: number): Promise<void> => {
    await getDb().execute({
      args: [value, attendeeId, eventId],
      sql: `UPDATE event_attendees SET ${field} = ? WHERE attendee_id = ? AND event_id = ?`,
    });
  };

const setRefunded = updateEventAttendeeField("refunded");
const setCheckedIn = updateEventAttendeeField("checked_in");

export const markRefunded = (
  attendeeId: number,
  eventId: number,
): Promise<void> => setRefunded(attendeeId, eventId, 1);

export const updateCheckedIn = (
  attendeeId: number,
  eventId: number,
  checkedIn: boolean,
): Promise<void> => setCheckedIn(attendeeId, eventId, checkedIn ? 1 : 0);

export const incrementAttachmentDownloads = async (
  attendeeId: number,
  eventId: number,
): Promise<void> => {
  await getDb().execute({
    args: [attendeeId, eventId],
    sql: "UPDATE event_attendees SET attachment_downloads = attachment_downloads + 1 WHERE attendee_id = ? AND event_id = ?",
  });
};

export const updateAttendeePII = async (
  attendeeId: number,
  input: UpdateAttendeePIIInput,
): Promise<void> => {
  const encryptedPiiBlob = await encryptPiiBlob(
    buildPiiBlob({
      ...input,
      payment_id: input.payment_id,
      ticket_token: input.ticket_token,
    }),
    settings.publicKey,
  );
  await getDb().execute({
    args: [encryptedPiiBlob, attendeeId],
    sql: "UPDATE attendees SET pii_blob = ? WHERE id = ?",
  });
};

/**
 * Recompute `end_at` on all existing `event_attendees` rows for an event
 * based on a new `duration_days` value. Leaves NULL-start rows alone.
 * The `.000Z` suffix matches the format fresh inserts produce via
 * toISOString() so raw-row dumps stay consistent.
 */
export const recomputeEventBookingRanges = async (
  eventId: number,
  durationDays: number,
): Promise<void> => {
  const duration = normalizeDurationDays(durationDays);
  await getDb().execute({
    args: [duration, eventId],
    sql: `UPDATE event_attendees
           SET end_at = REPLACE(datetime(start_at, '+' || ? || ' days'), ' ', 'T') || '.000Z'
           WHERE event_id = ? AND start_at IS NOT NULL`,
  });
  invalidateEventsCache();
};

/** A booking's day range as [start, end) YYYY-MM-DD strings (day-aligned —
 * every writer stores midnight-anchored ranges). */
type DayInterval = { start: string; end: string; quantity: number };

/**
 * After a duration change on a grouped event, check whether any day in any
 * existing booking's new range now exceeds the group cap. Returns the
 * earliest over-capacity day, or null if everything fits.
 * Call AFTER recomputeEventBookingRanges so end_at is already updated.
 *
 * One query fetches every booking row in the group; per-day occupancy is
 * computed in JS with a boundary sweep. Occupancy only changes on days
 * where some booking starts, so checking interval start days that fall
 * inside this event's booked ranges finds the earliest overflow without
 * walking (and querying) every day of every range.
 */
export const checkGroupCapAfterDurationChange = async (
  eventId: number,
  groupId: number,
): Promise<string | null> => {
  if (groupId <= 0) return null;
  const cap = await queryAll<{ max_attendees: number }>(
    "SELECT max_attendees FROM groups WHERE id = ?",
    [groupId],
  );
  const groupLimit = cap[0]!.max_attendees;
  if (groupLimit <= 0) return null;

  const rows = await queryAll<{
    event_id: number;
    event_type: string;
    start_at: string | null;
    end_at: string | null;
    quantity: number;
  }>(
    `SELECT ea.event_id, e.event_type, ea.start_at, ea.end_at, ea.quantity
     FROM event_attendees ea
     JOIN events e ON e.id = ea.event_id
     WHERE e.group_id = ?`,
    [groupId],
  );

  // Rows on non-daily events count on every day; daily rows count on the
  // days of their [start, end) range. NULL-range rows on daily events never
  // count (pre-daily legacy bookings), mirroring the SQL overlap predicate.
  type GroupRow = (typeof rows)[number];
  const isDailyWithRange = (row: GroupRow): boolean =>
    row.event_type === "daily" &&
    row.start_at !== null &&
    row.end_at !== null;
  const toDayInterval = (row: GroupRow): DayInterval => ({
    end: row.end_at!.slice(0, 10),
    quantity: row.quantity,
    start: row.start_at!.slice(0, 10),
  });
  const base = pipe(
    filter((row: GroupRow) => row.event_type !== "daily"),
    reduce((sum: number, row: GroupRow) => sum + row.quantity, 0),
  )(rows);
  const intervals = pipe(filter(isDailyWithRange), map(toDayInterval))(rows);
  const eventRanges = pipe(
    filter((row: GroupRow) => row.event_id === eventId),
    filter(isDailyWithRange),
    map(toDayInterval),
  )(rows);

  // Boundary sweep: running occupancy at each day where any interval starts
  // or ends. loadAt(day) = total daily quantity covering that day.
  const deltas = reduce((acc: Map<string, number>, itv: DayInterval) => {
    acc.set(itv.start, (acc.get(itv.start) ?? 0) + itv.quantity);
    acc.set(itv.end, (acc.get(itv.end) ?? 0) - itv.quantity);
    return acc;
  }, new Map<string, number>())(intervals);
  const boundaries = [...deltas.keys()].sort();
  const loadAt = new Map<string, number>();
  let running = 0;
  for (const day of boundaries) {
    running += deltas.get(day)!;
    loadAt.set(day, running);
  }

  // Walk candidate days (interval starts) in ascending order, tracking the
  // max end of this event's ranges that start at or before the candidate —
  // the candidate is inside this event's booked days iff that end is later.
  const sortedRanges = sort((a: DayInterval, b: DayInterval) =>
    a.start < b.start ? -1 : 1
  )(eventRanges);
  const startDays = unique(
    map((interval: DayInterval) => interval.start)(intervals),
  ).sort();
  let rangeIdx = 0;
  let maxEnd = "";
  for (const day of startDays) {
    while (rangeIdx < sortedRanges.length && sortedRanges[rangeIdx]!.start <= day) {
      const end = sortedRanges[rangeIdx]!.end;
      if (end > maxEnd) maxEnd = end;
      rangeIdx++;
    }
    if (day >= maxEnd) continue;
    if (base + loadAt.get(day)! > groupLimit) return day;
  }
  return null;
};

/**
 * Update a single event link's quantity and date with atomic capacity check.
 *
 * The per-day SQL WHERE clause enforces capacity atomically. High-traffic
 * paths (public booking) should preflight with checkEventAvailability or
 * checkBatchAvailability to fail fast before hitting the DB — admin paths
 * may rely on the SQL guard alone.
 */
export const updateEventLink = async (
  attendeeId: number,
  eventId: number,
  input: UpdateEventLinkInput,
): Promise<UpdateEventLinkResult> => {
  const { quantity: qty, date, durationDays = 1 } = input;
  const { startAt, endAt } = dateToStartEnd(date, durationDays);
  const condition = buildCapacityCondition(
    eventId,
    qty,
    date,
    attendeeId,
    durationDays,
  );

  const result = await getDb().execute({
    args: [qty, startAt, endAt, attendeeId, eventId, ...condition.args],
    sql: `UPDATE event_attendees SET quantity = ?, start_at = ?, end_at = ?
          WHERE attendee_id = ? AND event_id = ? AND ${condition.sql}`,
  });

  return checkCapacityResult(result);
};

/**
 * Add a new event link for an existing attendee with atomic capacity check.
 *
 * The per-day SQL WHERE clause enforces capacity atomically. See
 * updateEventLink for preflight guidance.
 */
export const addEventLink = async (
  attendeeId: number,
  booking: EventBooking,
): Promise<UpdateEventLinkResult> =>
  checkCapacityResult(
    await getDb().execute(buildCapacityCheckedInsert(booking, "?", attendeeId)),
  );
