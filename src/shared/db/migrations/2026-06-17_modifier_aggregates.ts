import { schemaMigration } from "./define.ts";

export default schemaMigration(
  "2026-06-17_modifier_aggregates",
  "Add total_uses, usage_count and total_revenue aggregate columns to modifiers, maintained by triggers on modifier_usages, so admin modifier reads avoid scanning the usage ledger; backfill from existing data",
  {
    columns: {
      modifiers: ["total_uses", "usage_count", "total_revenue"],
    },
    triggers: [
      "trg_modifier_usages_aggregates_insert",
      "trg_modifier_usages_aggregates_delete",
      "trg_modifier_usages_aggregates_update",
    ],
  },
  ({ backfillModifierAggregates }) => backfillModifierAggregates(),
);
