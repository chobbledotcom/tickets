import type {
  Migration,
  MigrationContext,
  SchemaRequirement,
} from "./types.ts";

const requires: SchemaRequirement = {
  columns: { listings: ["customisable_days", "day_prices"] },
};

export default function listingCustomisableDaysMigration({
  additive,
  applySchemaChanges,
}: MigrationContext): Migration {
  return additive({
    description:
      "Add customisable_days and day_prices columns to listings so visitors can choose how many days to book with per-day-count pricing",
    id: "2026-06-14_listing_customisable_days",
    requires,
    up: applySchemaChanges,
  });
}
