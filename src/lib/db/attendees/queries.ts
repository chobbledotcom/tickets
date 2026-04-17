/**
 * Read queries for attendees and their per-event bookings.
 */

import { map } from "#fp";
import { computeTicketTokenIndex } from "#lib/crypto/hashing.ts";
import type {
  AttendeeWithBookings,
  EventAttendeeRow,
} from "#lib/db/attendee-types.ts";
import { decryptAttendeeFields } from "#lib/db/attendees/pii.ts";
import { inPlaceholders, queryAll, queryOne } from "#lib/db/client.ts";
import type { Attendee } from "#lib/types.ts";

/**
 * Attendee columns for JOIN queries — only the columns actually used at runtime.
 * All PII is read from the encrypted pii_blob; per-event status lives on event_attendees.
 */
const ATTENDEE_COLS = "a.id, a.created, a.ticket_token_index, a.pii_blob";

/** Columns sourced from event_attendees (per-event data) */
const EA_COLS =
  "ea.event_id, SUBSTR(ea.start_at, 1, 10) as date, ea.quantity, ea.checked_in, ea.refunded, ea.price_paid, ea.attachment_downloads";

/** SELECT clause for attendee + event_attendees JOINs (INNER JOIN context).
 * Derives `date` from start_at for backward compatibility with the Attendee type. */
export const ATTENDEE_JOIN_SELECT = `${ATTENDEE_COLS}, ${EA_COLS}`;

/** SELECT clause for LEFT JOIN context — COALESCEs nullable join columns so
 * attendees with broken/missing event_attendees linkage still appear in results
 * (with event_id=0 as an obvious corruption indicator). */
export const ATTENDEE_LEFT_JOIN_SELECT =
  `${ATTENDEE_COLS}, COALESCE(ea.event_id, 0) as event_id, SUBSTR(ea.start_at, 1, 10) as date, COALESCE(ea.quantity, 0) as quantity, COALESCE(ea.checked_in, 0) as checked_in, COALESCE(ea.refunded, 0) as refunded, COALESCE(ea.price_paid, 0) as price_paid, COALESCE(ea.attachment_downloads, 0) as attachment_downloads`;

/**
 * Get attendees for an event without decrypting PII
 * Used for tests and operations that don't need decrypted data
 */
export const getAttendeesRaw = (eventId: number): Promise<Attendee[]> =>
  queryAll<Attendee>(
    `SELECT ${ATTENDEE_JOIN_SELECT}
     FROM attendees a
     JOIN event_attendees ea ON ea.attendee_id = a.id
     WHERE ea.event_id = ?
     ORDER BY a.created DESC`,
    [eventId],
  );

/**
 * Get the newest attendees across all events without decrypting PII.
 * Used for the admin dashboard to show recent registrations.
 */
export const getNewestAttendeesRaw = (limit: number): Promise<Attendee[]> =>
  queryAll<Attendee>(
    `SELECT ${ATTENDEE_LEFT_JOIN_SELECT}
     FROM attendees a
     LEFT JOIN event_attendees ea ON ea.attendee_id = a.id
     ORDER BY a.created DESC LIMIT ?`,
    [limit],
  );

/**
 * Get an attendee by ID without decrypting PII
 * Used for payment callbacks and webhooks where decryption is not needed
 * Returns the attendee with encrypted fields (id, event_id, quantity are plaintext)
 */
export const getAttendeeRaw = (id: number): Promise<Attendee | null> => {
  return queryOne<Attendee>(
    `SELECT ${ATTENDEE_LEFT_JOIN_SELECT}
     FROM attendees a
     LEFT JOIN event_attendees ea ON ea.attendee_id = a.id
     WHERE a.id = ?`,
    [id],
  );
};

/**
 * Get an attendee by ID (decrypted)
 * Requires private key for decryption - only available to authenticated sessions
 */
export const getAttendee = async (
  id: number,
  privateKey: CryptoKey,
): Promise<Attendee | null> => {
  const row = await getAttendeeRaw(id);
  return row ? decryptAttendeeFields(row, privateKey) : null;
};

/**
 * Look up attendees by plaintext tokens, returning full booking data.
 * Two queries: attendees by token index, then all event_attendees for those attendees.
 * Returns results in the same order as input tokens (deduped). Bookings sorted
 * by start_at then event_id for deterministic ordering.
 */
export const getAttendeesByTokens = async (
  tokens: string[],
): Promise<(AttendeeWithBookings | null)[]> => {
  // Dedupe tokens to prevent double processing
  const uniqueTokens = [...new Set(tokens)];
  const tokenIndexes = await Promise.all(
    map((t: string) => computeTicketTokenIndex(t))(uniqueTokens),
  );

  // Query 1: Get attendee base rows (no event join)
  type AttendeeBase = {
    id: number;
    created: string;
    ticket_token_index: string;
    pii_blob: string;
  };
  const attendeeRows = await queryAll<AttendeeBase>(
    `SELECT id, created, ticket_token_index, pii_blob
     FROM attendees WHERE ticket_token_index IN (${
      inPlaceholders(tokenIndexes)
    })`,
    tokenIndexes,
  );

  if (attendeeRows.length === 0) {
    return tokens.map(() => null);
  }

  // Query 2: Get all event links for these attendees
  const attendeeIds = attendeeRows.map((a) => a.id);
  const bookingRows = await queryAll<
    EventAttendeeRow & { attendee_id: number }
  >(
    `SELECT attendee_id, event_id, start_at, end_at, quantity, checked_in, refunded, price_paid, attachment_downloads
     FROM event_attendees WHERE attendee_id IN (${inPlaceholders(attendeeIds)})
     ORDER BY start_at, event_id`,
    attendeeIds,
  );

  // Group bookings by attendee_id
  const bookingsByAttendee = new Map<number, EventAttendeeRow[]>();
  for (const row of bookingRows) {
    const list = bookingsByAttendee.get(row.attendee_id) ?? [];
    list.push({
      attachment_downloads: row.attachment_downloads,
      checked_in: row.checked_in,
      end_at: row.end_at,
      event_id: row.event_id,
      price_paid: row.price_paid,
      quantity: row.quantity,
      refunded: row.refunded,
      start_at: row.start_at,
    });
    bookingsByAttendee.set(row.attendee_id, list);
  }

  // Build AttendeeWithBookings map by token index
  const byTokenIndex = new Map<string, AttendeeWithBookings>();
  for (const row of attendeeRows) {
    byTokenIndex.set(row.ticket_token_index, {
      bookings: bookingsByAttendee.get(row.id) ?? [],
      created: row.created,
      id: row.id,
      pii_blob: row.pii_blob,
      ticket_token: "", // populated after decryption by caller
      ticket_token_index: row.ticket_token_index,
    });
  }

  // Return in original token order (before dedup) using the unique index mapping
  const indexToResult = new Map(
    uniqueTokens.map((t, i) => [t, byTokenIndex.get(tokenIndexes[i]!) ?? null]),
  );
  return tokens.map((t) => indexToResult.get(t) ?? null);
};
