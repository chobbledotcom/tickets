import { schemaMigration } from "./define.ts";

export default schemaMigration(
  "2026-10-26_attendees_pending_flags_index",
  "Add idx_attendees_pending_flags, a partial index over the attendees with a pending notification flag. The dashboard count then seeks the few flagged rows instead of reading every attendee row on each dashboard load.",
  {
    indexes: ["idx_attendees_pending_flags"],
  },
);
