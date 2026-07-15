import { schemaMigration } from "./define.ts";

export default schemaMigration(
  "2026-07-15_attendee_status_integrity",
  "Reject attendee writes that refer to a missing status.",
  {
    triggers: [
      "trg_attendees_validate_status_insert",
      "trg_attendees_validate_status_update",
    ],
  },
);
