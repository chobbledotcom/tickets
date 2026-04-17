/**
 * Update operations for attendees and their per-event bookings.
 */

import type {
  EventBooking,
  UpdateAttendeePIIInput,
  UpdateEventLinkInput,
  UpdateEventLinkResult,
} from "#lib/db/attendee-types.ts";
import {
  buildCapacityCheckedInsert,
  checkCapacityResult,
  dateToStartEnd,
} from "#lib/db/attendees/capacity.ts";
import { buildPiiBlob, encryptPiiBlob } from "#lib/db/attendees/pii.ts";
import { buildCapacityCondition } from "#lib/db/capacity.ts";
import { getDb } from "#lib/db/client.ts";
import { settings } from "#lib/db/settings.ts";

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

/**
 * Mark an attendee as refunded for a specific event.
 * Keeps payment_id intact so payment details can still be viewed.
 */
export const markRefunded = (
  attendeeId: number,
  eventId: number,
): Promise<void> => setRefunded(attendeeId, eventId, 1);

/**
 * Update an attendee's checked_in status for a specific event.
 * Caller must be authenticated admin (public key always exists after setup)
 */
export const updateCheckedIn = (
  attendeeId: number,
  eventId: number,
  checkedIn: boolean,
): Promise<void> => setCheckedIn(attendeeId, eventId, checkedIn ? 1 : 0);

/**
 * Increment the attachment download counter for an attendee.
 * Uses atomic SQL increment to avoid race conditions.
 */
export const incrementAttachmentDownloads = async (
  attendeeId: number,
  eventId: number,
): Promise<void> => {
  await getDb().execute({
    args: [attendeeId, eventId],
    sql: "UPDATE event_attendees SET attachment_downloads = attachment_downloads + 1 WHERE attendee_id = ? AND event_id = ?",
  });
};

/**
 * Update an attendee's PII (name, email, phone, etc.) — shared across all event links.
 * Caller must be authenticated admin (public key always exists after setup).
 */
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
 * Update a single event link's quantity and date with atomic capacity check.
 * Excludes this attendee's current row from the capacity calculation.
 */
export const updateEventLink = async (
  attendeeId: number,
  eventId: number,
  input: UpdateEventLinkInput,
): Promise<UpdateEventLinkResult> => {
  const { quantity: qty, date } = input;
  const { startAt, endAt } = dateToStartEnd(date);
  const condition = buildCapacityCondition(eventId, qty, date, attendeeId);

  const result = await getDb().execute({
    args: [qty, startAt, endAt, attendeeId, eventId, ...condition.args],
    sql: `UPDATE event_attendees SET quantity = ?, start_at = ?, end_at = ?
          WHERE attendee_id = ? AND event_id = ? AND ${condition.sql}`,
  });

  return checkCapacityResult(result);
};

/**
 * Add a new event link for an existing attendee with atomic capacity check.
 * Does NOT create a new attendee or touch PII — just inserts an event_attendees row.
 */
export const addEventLink = async (
  attendeeId: number,
  booking: EventBooking,
): Promise<UpdateEventLinkResult> =>
  checkCapacityResult(
    await getDb().execute(buildCapacityCheckedInsert(booking, "?", attendeeId)),
  );
