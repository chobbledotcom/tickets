import { schemaMigration } from "./define.ts";

export default schemaMigration(
  "2026-09-29_registration_email_work",
  "Keep each registration email retryable without storing its plaintext in the database",
  {
    indexes: [
      "idx_registration_email_work_identity",
      "idx_registration_email_work_due",
      "idx_registration_email_work_attendee",
    ],
    newTables: ["registration_email_work"],
  },
);
