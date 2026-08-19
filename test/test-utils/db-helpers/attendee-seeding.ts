/**
 * Filling a listing with attendees quickly, for tests about paging and volume.
 */

import { createTestAttendeeDirect } from "#test-utils/db-helpers/attendees.ts";

/**
 * Register `count` throwaway attendees on the listing. One is booked through
 * the real production path; the rest are copies of that row (same encrypted
 * PII, fresh unique token index), inserted in a single batch — page-filling
 * needs volume, not a hundred full bookings.
 *
 * Copies get higher AUTOINCREMENT ids than every earlier row, so newest-first
 * (id-ordered) paging sees them exactly like real bookings made after an
 * earlier fixture attendee.
 */
export const seedFillerAttendees = async (
  listingId: number,
  count: number,
): Promise<void> => {
  const { getDb } = await import("#db/client.ts");
  const { attendee } = await createTestAttendeeDirect(
    listingId,
    "Filler",
    "filler@example.com",
  );
  const clones = [];
  for (let index = 1; index < count; index++) {
    clones.push(
      {
        args: [`filler-token-${index}`, attendee.id],
        sql: `INSERT INTO attendees (created, kind, checked_in, ticket_token_index, pii_blob, status_id)
                  SELECT created, kind, checked_in, ?, pii_blob, status_id
                  FROM attendees WHERE id = ?`,
      },
      {
        args: [attendee.id],
        sql: `INSERT INTO listing_attendees (listing_id, attendee_id, start_at, end_at, quantity, checked_in)
                  SELECT listing_id, last_insert_rowid(), start_at, end_at, quantity, checked_in
                  FROM listing_attendees WHERE attendee_id = ?`,
      },
    );
  }
  await getDb().batch(clones, "write");
};
