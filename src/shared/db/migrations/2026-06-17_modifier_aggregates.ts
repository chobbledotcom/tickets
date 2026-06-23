import { schemaMigration } from "./define.ts";

export default schemaMigration(
  "2026-06-17_modifier_aggregates",
  "Add total_uses and usage_count aggregate columns to modifiers, maintained by triggers on modifier_usages, so admin modifier reads avoid scanning the usage ledger; backfill from existing data. (This historically also added a total_revenue column, since dropped — a modifier's revenue is projected from the transfers ledger as balanceOf(modifier:M); see 2026-06-22_drop_modifiers_total_revenue.)",
  {
    columns: {
      modifiers: ["total_uses", "usage_count"],
    },
    triggers: [
      "trg_modifier_usages_aggregates_insert",
      "trg_modifier_usages_aggregates_delete",
      "trg_modifier_usages_aggregates_update",
    ],
  },
  ({ backfillModifierAggregates }) => backfillModifierAggregates(),
);
