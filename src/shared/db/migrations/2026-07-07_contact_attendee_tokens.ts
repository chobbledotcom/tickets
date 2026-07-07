import { schemaMigration } from "./define.ts";

export default schemaMigration(
  "2026-07-07_contact_attendee_tokens",
  "Add attendee_tokens_blob to contact_preferences: an append-only, owner-key-encrypted list of the ticket tokens booked under each contact (email/phone). The keyless public checkout can only append (encrypt with the public key, string-concat onto the column), so — unlike the stats_blob — it never has to read the existing value. Tokens rather than sequential ids are stored so a decrypted payload leaks nothing guessable. Not backfilled: existing contacts' bookings can't be linked without decrypting every attendee's PII, so the list only fills from bookings made after this ships",
  {
    columns: {
      contact_preferences: ["attendee_tokens_blob"],
    },
  },
);
