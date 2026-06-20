import { schemaMigration } from "./define.ts";

export default schemaMigration(
  "2026-06-20_contact_booking_counts",
  "Add public_booking_count and admin_booking_count plaintext columns to contact_preferences so booking history is split by source (online checkout vs admin manual add); the keyless public booking paths can increment their count without the owner private key, unlike the encrypted stats_blob",
  {
    columns: {
      contact_preferences: ["public_booking_count", "admin_booking_count"],
    },
  },
);
