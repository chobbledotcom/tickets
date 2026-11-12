import { CONFIG_KEYS } from "#shared/settings/keys.ts";
import { schemaMigration } from "./define.ts";
import { SUBSCRIPTION_TRIGGER_NAMES } from "./schema/admin-feature-triggers.ts";

export default schemaMigration(
  "2026-11-10_subscriptions",
  "Add the recurring price and frequency of a listing, and the Stripe subscription plan of a booking row. Every existing row starts with no subscription, and the stored feature list gets the subscriptions feature turned off.",
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
  // A feature list is valid only when it names every feature, so a list
  // saved before this feature existed must gain the key.
  async ({ getDb }) => {
    await getDb().execute({
      args: [CONFIG_KEYS.ENABLED_FEATURES],
      sql: `UPDATE settings
               SET value = json_set(value, '$.subscriptions', json('false'))
             WHERE key = ?
               AND json_valid(value)
               AND json_type(value, '$.subscriptions') IS NULL`,
    });
  },
);
