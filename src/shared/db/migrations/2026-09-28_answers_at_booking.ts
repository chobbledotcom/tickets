import { schemaMigration } from "./define.ts";

export default schemaMigration(
  "2026-09-28_answers_at_booking",
  "Add answers_at_booking. A booking copies the questions it asked and the " +
    "answer to each, so the attendee page can show which answers an admin " +
    "changed later. Bookings made before this migration have no rows.",
  {
    indexes: ["idx_answers_at_booking_unique"],
    newTables: ["answers_at_booking"],
  },
);
