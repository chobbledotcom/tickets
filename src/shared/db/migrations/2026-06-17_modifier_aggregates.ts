import type {
  Migration,
  MigrationContext,
  SchemaRequirement,
} from "./types.ts";

const requires: SchemaRequirement = {
  columns: {
    modifiers: ["total_uses", "usage_count", "total_revenue"],
  },
  triggers: [
    "trg_modifier_usages_aggregates_insert",
    "trg_modifier_usages_aggregates_delete",
    "trg_modifier_usages_aggregates_update",
  ],
};

export default function modifierAggregatesMigration({
  additive,
  applySchemaChanges,
  backfillModifierAggregates,
  syncTriggers,
}: MigrationContext): Migration {
  return additive({
    description:
      "Add total_uses, usage_count and total_revenue aggregate columns to modifiers, maintained by triggers on modifier_usages, so admin modifier reads avoid scanning the usage ledger; backfill from existing data",
    id: "2026-06-17_modifier_aggregates",
    requires,
    up: async () => {
      await applySchemaChanges();
      // Triggers first, then an absolute recompute: any usage write that slips
      // in between is counted by the trigger and then overwritten by the fresh
      // backfill total, so no insert can be lost.
      await syncTriggers();
      await backfillModifierAggregates();
    },
  });
}
