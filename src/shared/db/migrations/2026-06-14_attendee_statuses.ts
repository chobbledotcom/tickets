import { schemaMigration } from "./define.ts";

export default schemaMigration(
  "2026-06-14_attendee_statuses",
  "Add attendee_statuses table, status_id + remaining_balance on attendees, and attendee_id on activity_log; seed the default status and backfill existing attendees onto it",
  {
    columns: {
      activity_log: ["attendee_id"],
      attendees: ["status_id", "remaining_balance"],
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
