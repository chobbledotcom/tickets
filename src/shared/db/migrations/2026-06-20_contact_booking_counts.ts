import { schemaMigration } from "./define.ts";

export default schemaMigration(
  "2026-06-20_contact_booking_counts",
  "Add public_booking_count and admin_booking_count plaintext columns to contact_preferences so booking history is split by source (online checkout vs admin manual add); the keyless public booking paths can increment their count without the owner private key, unlike the encrypted stats_blob",
  {
    columns: {
      contact_preferences: ["public_booking_count", "admin_booking_count"],
    },
  },
  async ({ getDb }) => {
    // One-time backfill: contacts that predate the split already have a
    // `visits` count (incremented once per order by createAttendeeAtomic),
    // but the new columns default to 0 — so every returning contact would
    // otherwise show zero bookings. Each historical order incremented visits
    // once, mirroring a booking, so seed public_booking_count from visits.
    // We attribute them to the public channel (the dominant path; the rarer
    // admin manual-adds can be corrected per-contact via the record editor).
    // The guard means new rows, which only become non-zero after a booking,
    // are never re-touched once this has run.
    await getDb().execute(
      "UPDATE contact_preferences SET public_booking_count = visits WHERE public_booking_count = 0",
    );
  },
);
