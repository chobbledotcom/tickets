import type {
  Migration,
  MigrationContext,
  SchemaRequirement,
} from "./types.ts";

type MigrationBuilder = (context: MigrationContext) => Migration;
type SchemaMigrationAfter = (context: MigrationContext) => Promise<void>;

const hasEntries = (values: readonly unknown[] | undefined): boolean =>
  (values?.length ?? 0) > 0;

const hasColumnRequirements = (requires: SchemaRequirement): boolean =>
  Object.values(requires.columns ?? {}).some(hasEntries);

const runSchemaSync = async (
  context: MigrationContext,
  requires: SchemaRequirement,
): Promise<void> => {
  if (hasEntries(requires.newTables) || hasColumnRequirements(requires)) {
    await context.applySchemaChanges();
  }
  if (hasEntries(requires.indexes)) await context.syncIndexes();
  // Trigger sync precedes after() so aggregate migrations can install triggers
  // before their absolute recompute backfills.
  if (hasEntries(requires.triggers)) await context.syncTriggers();
};

export const schemaMigration =
  (
    id: string,
    description: string,
    requires: SchemaRequirement,
    after?: SchemaMigrationAfter,
  ): MigrationBuilder =>
  (context) =>
    context.additive({
      description,
      id,
      requires,
      up: async () => {
        await runSchemaSync(context, requires);
        await after?.(context);
      },
    });

/**
 * A migration that drops a column by rebuilding its table from the (already
 * column-free) SCHEMA. A bare column drop owns no additive object, so it carries
 * `{}` requires and the schema-hash guard covers the change. `recreateTable`
 * preserves every surviving column and rebuilds the table's indexes and triggers.
 * Use this for any "the column is gone from SCHEMA, drop it from the live table"
 * migration; reach for {@link schemaMigration} directly only when the drop also
 * has to rewrite trigger bodies or run extra work around the rebuild.
 */
export const columnDropMigration = (
  id: string,
  table: string,
  description: string,
): MigrationBuilder =>
  schemaMigration(id, description, {}, async ({ recreateTable }) => {
    await recreateTable(table); // rebuild from SCHEMA, dropping the column
  });
