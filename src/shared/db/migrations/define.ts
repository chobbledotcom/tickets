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
