import { schemaMigration } from "./define.ts";

export default schemaMigration(
  "2026-11-24_subscription_index",
  "Add idx_listing_attendees_subscription over the subscription status and Stripe id of each booking row. A subscription delivery and the scheduled check then seek the subscribed rows instead of reading every booking row.",
  {
    indexes: ["idx_listing_attendees_subscription"],
  },
);
