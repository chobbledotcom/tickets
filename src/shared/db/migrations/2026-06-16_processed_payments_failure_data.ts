import type {
  Migration,
  MigrationContext,
  SchemaRequirement,
} from "./types.ts";

const requires: SchemaRequirement = {
  columns: { processed_payments: ["failure_data"] },
};

export default function processedPaymentsFailureDataMigration({
  additive,
  applySchemaChanges,
}: MigrationContext): Migration {
  return additive({
    description:
      "Add failure_data to processed_payments so a handled payment failure (refund/sold-out/price-change) is recorded as a terminal outcome and replayed idempotently instead of leaving a stuck reservation",
    id: "2026-06-16_processed_payments_failure_data",
    requires,
    up: applySchemaChanges,
  });
}
