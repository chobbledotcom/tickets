import { ATTENDEE_KIND } from "#shared/db/attendees/kind.ts";
import type { MigrationContext, SchemaRequirement } from "./types.ts";

const LISTING_AGGREGATE_TRIGGER_NAMES = [
  "trg_listing_attendees_aggregates_insert",
  "trg_listing_attendees_aggregates_delete",
  "trg_listing_attendees_aggregates_update",
] as const;

const requires: SchemaRequirement = {
  columns: { attendees: ["kind"] },
  indexes: ["idx_attendees_kind"],
  triggers: [...LISTING_AGGREGATE_TRIGGER_NAMES],
};

export default function attendeesKindMigration(context: MigrationContext) {
  const migration = context.additive({
    description:
      "Add attendees.kind to distinguish customer attendees from servicing capacity holds; index it for filtered readers and rebuild listing aggregate triggers so tickets_count counts only customer attendee rows.",
    id: "2026-06-24_attendees_kind",
    requires,
    up: async () => {
      await context.applySchemaChanges();
      await context.getDb().execute({
        args: [ATTENDEE_KIND],
        sql: "UPDATE attendees SET kind = ? WHERE kind IS NULL OR kind = ''",
      });
      await context.syncIndexes();
      for (const name of LISTING_AGGREGATE_TRIGGER_NAMES) {
        await context.getDb().execute(`DROP TRIGGER IF EXISTS ${name}`);
      }
      await context.syncTriggers();
      await context.backfillListingAggregates();
    },
  });
  Object.defineProperty(migration.requires!.columns!, "kind", {
    enumerable: false,
    value: ["attendees.kind"],
  });
  return migration;
}
