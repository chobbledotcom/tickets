import { schemaMigration } from "./define.ts";

export default schemaMigration(
  "2026-06-14_attendee_statuses",
  // Historically this also added attendees.remaining_balance, but that column is
  // now projected from the transfers ledger and dropped by a later migration, so
  // it is no longer an owned additive column here (a production DB that ran the
  // original still has it until the drop; a fresh DB never gets it).
  "Add attendee_statuses table, status_id on attendees, and attendee_id on activity_log; seed the default status and backfill existing attendees onto it",
  {
    columns: {
      activity_log: ["attendee_id"],
      attendees: ["status_id"],
    },
    indexes: [
      "idx_attendee_statuses_sort_order",
      "idx_attendees_status_id",
      "idx_activity_log_attendee_id",
    ],
    newTables: ["attendee_statuses"],
  },
  ({ ensureDefaultAttendeeStatus }) => ensureDefaultAttendeeStatus(),
);
