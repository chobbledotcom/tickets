/**
 * Update operations for attendees and their per-event bookings.
 */

import type {
  EventBooking,
  UpdateAttendeePIIInput,
  UpdateEventLinkInput,
  UpdateEventLinkResult,
} from "#shared/db/attendee-types.ts";
import {
  buildCapacityCheckedInsert,
  CAPACITY_EXCEEDED,
  checkCapacityResult,
  checkEventAvailability,
  dateToStartEnd,
} from "#shared/db/attendees/capacity.ts";
import { buildPiiBlob, encryptPiiBlob } from "#shared/db/attendees/pii.ts";
import { buildCapacityCondition } from "#shared/db/capacity.ts";
import { getDb, queryAll } from "#shared/db/client.ts";
import { invalidateEventsCache } from "#shared/db/events.ts";
import { settings } from "#shared/db/settings.ts";
import { addDays } from "#shared/dates.ts";

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
  const duration = Math.max(1, Math.floor(durationDays));
  await getDb().execute({
    args: [duration, eventId],
    sql: `UPDATE event_attendees
           SET end_at = REPLACE(datetime(start_at, '+' || ? || ' days'), ' ', 'T') || '.000Z'
           WHERE event_id = ? AND start_at IS NOT NULL`,
  });
  invalidateEventsCache();
};

/**
 * After a duration change on a grouped event, check whether any day in any
 * existing booking's new range now exceeds the group cap. Returns the first
 * over-capacity day, or null if everything fits.
 * Call AFTER recomputeEventBookingRanges so end_at is already updated.
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

  const rows = await queryAll<{ start_at: string; end_at: string }>(
    "SELECT DISTINCT start_at, end_at FROM event_attendees WHERE event_id = ? AND start_at IS NOT NULL",
    [eventId],
  );
  for (const row of rows) {
    const startDate = row.start_at.slice(0, 10);
    const endMs = new Date(row.end_at).getTime();
    const startMs = new Date(row.start_at).getTime();
    const days = Math.round((endMs - startMs) / 86_400_000);
    for (let i = 0; i < days; i++) {
      const day = addDays(startDate, i);
      const dayStart = `${day}T00:00:00Z`;
      const dayEnd = new Date(
        new Date(dayStart).getTime() + 86_400_000,
      ).toISOString();
      const counted = await queryAll<{ count: number }>(
        `SELECT COALESCE(SUM(ea.quantity), 0) as count
         FROM event_attendees ea
         JOIN events e ON e.id = ea.event_id
         WHERE e.group_id = ?
           AND (e.event_type != 'daily' OR (ea.start_at < ? AND ea.end_at > ?))`,
        [groupId, dayEnd, dayStart],
      );
      if (counted[0]!.count > groupLimit) return day;
    }
  }
  return null;
};

/**
 * Update a single event link's quantity and date with atomic capacity check.
 * Self-excluding preflight first (avoids false-rejection on multi-day ranges
 * that contain non-overlapping existing bookings); atomic SQL UPDATE is the
 * race-free safety net.
 */
export const updateEventLink = async (
  attendeeId: number,
  eventId: number,
  input: UpdateEventLinkInput,
): Promise<UpdateEventLinkResult> => {
  const { quantity: qty, date, durationDays = 1 } = input;

  const preflight = await checkEventAvailability(
    eventId,
    qty,
    date,
    attendeeId,
    durationDays,
  );
  if (!preflight) return CAPACITY_EXCEEDED;

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
 * Runs a per-day preflight so multi-day events aren't false-rejected by the
 * SQL overlap-sum safety net.
 */
export const addEventLink = async (
  attendeeId: number,
  booking: EventBooking,
): Promise<UpdateEventLinkResult> => {
  const preflight = await checkEventAvailability(
    booking.eventId,
    booking.quantity ?? 1,
    booking.date ?? null,
    undefined,
    booking.durationDays ?? 1,
  );
  if (!preflight) return CAPACITY_EXCEEDED;

  return checkCapacityResult(
    await getDb().execute(buildCapacityCheckedInsert(booking, "?", attendeeId)),
  );
};
