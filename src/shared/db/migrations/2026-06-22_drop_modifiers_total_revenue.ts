import { triggerRewriteDropMigration } from "./define.ts";

/** The modifier-aggregate triggers whose revenue maintenance is being removed. */
const AGGREGATE_TRIGGERS = [
  "trg_modifier_usages_aggregates_insert",
  "trg_modifier_usages_aggregates_delete",
  "trg_modifier_usages_aggregates_update",
];

export default triggerRewriteDropMigration(
  "2026-06-22_drop_modifiers_total_revenue",
  "modifiers",
  AGGREGATE_TRIGGERS,
  "Drop modifiers.total_revenue and the amount_applied lines of its maintaining " +
    "triggers: a modifier's revenue is now projected from the transfers ledger " +
    "as balanceOf(modifier:M) (the modifier account's net effect on revenue — " +
    "surcharges in as the destination, discounts out as the source, read " +
    "directly) at read time, so the stored aggregate is removed. total_uses and " +
    "usage_count stay trigger-maintained. No modifier was ever used in " +
    "production, so the projection equals 0 for every existing modifier — there " +
    "is no backfill dependency. No `requires`: a column drop plus a trigger-body " +
    "change isn't an additive object, so it owns nothing the restore test can " +
    "drop and rebuild; the schema-hash guard covers the change.",
);
