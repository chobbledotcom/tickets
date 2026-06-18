import { schemaMigration } from "./define.ts";

export default schemaMigration(
  "2026-06-16_attendee_phone_index",
  "Add phone_index to attendees so inbound SMS replies can be matched to an attendee",
  {
    columns: { attendees: ["phone_index"] },
    indexes: ["idx_attendees_phone_index"],
  },
);
