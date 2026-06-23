import { schemaMigration } from "./define.ts";

export default schemaMigration(
  "2026-06-23_attendee_order_parent",
  "Add order_token and parent_listing_id columns to listing_attendees so every attendee row created in one checkout shares a booking token and a folded child row records which parent listing it was chosen under",
  {
    columns: {
      listing_attendees: ["order_token", "parent_listing_id"],
    },
  },
);
