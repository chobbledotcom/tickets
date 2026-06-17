import type {
  Migration,
  MigrationContext,
  SchemaRequirement,
} from "./types.ts";

const requires: SchemaRequirement = {
  indexes: [
    "idx_modifiers_code_index",
    "idx_modifier_listings_pair",
    "idx_modifier_listings_listing",
    "idx_modifier_groups_pair",
    "idx_modifier_groups_group",
    "idx_modifier_usages_modifier",
    "idx_modifier_usages_attendee",
  ],
  newTables: [
    "modifiers",
    "modifier_listings",
    "modifier_groups",
    "modifier_usages",
  ],
};

export default function modifiersMigration({
  additive,
  applySchemaChanges,
  syncIndexes,
}: MigrationContext): Migration {
  return additive({
    description:
      "Add modifiers table for owner-defined price modifiers (surcharges, discounts, add-ons), plus modifier_listings, modifier_groups and modifier_usages for scoping and stock",
    id: "2026-06-16_modifiers",
    requires,
    up: async () => {
      await applySchemaChanges();
      await syncIndexes();
    },
  });
}
