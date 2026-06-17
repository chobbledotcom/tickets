import type {
  Migration,
  MigrationContext,
  SchemaRequirement,
} from "./types.ts";

const requires: SchemaRequirement = {
  indexes: ["idx_sumup_checkouts_sumup_id"],
  newTables: ["sumup_checkouts"],
};

export default function sumupCheckoutsMigration({
  additive,
  applySchemaChanges,
  syncIndexes,
}: MigrationContext): Migration {
  return additive({
    description:
      "Add encrypted sumup_checkouts staging table for SumUp metadata",
    id: "2026-06-12_sumup_checkouts",
    requires,
    up: async () => {
      await applySchemaChanges();
      await syncIndexes();
    },
  });
}
