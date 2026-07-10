import { schemaMigration } from "./define.ts";

export default schemaMigration(
  "2026-07-07_contact_attendee_tokens",
  "Add attendee_tokens_blob to contact_preferences: an append-only list of contact-scoped blind ticket-token markers plus owner-key-encrypted ticket tokens booked under each contact (email/phone). The keyless public checkout can append with the public key and blind marker only, so — unlike the stats_blob — it never has to read the existing value. Tokens rather than sequential ids are encrypted so a decrypted payload leaks nothing guessable. Not backfilled: existing contacts' bookings can't be linked without decrypting every attendee's PII, so the list only fills from bookings made after this ships",
  {
    columns: {
      contact_preferences: ["attendee_tokens_blob"],
    },
  },
);
