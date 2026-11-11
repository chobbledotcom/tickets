import { schemaMigration } from "./define.ts";
import { SUBSCRIPTION_TRIGGER_NAMES } from "./schema/admin-feature-triggers.ts";

export default schemaMigration(
  "2026-11-10_subscriptions",
  "Add the recurring price and frequency of a listing, and the Stripe subscription plan of a booking row. Every existing row starts with no subscription.",
  {
    columns: {
      listing_attendees: [
        "recurring_price",
        "recurring_tax",
        "recurring_interval",
        "subscription_id",
        "subscription_status",
      ],
      listings: ["recurring_price", "recurring_interval"],
    },
    triggers: SUBSCRIPTION_TRIGGER_NAMES,
  },
);
