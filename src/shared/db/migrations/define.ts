import { TRIGGERS } from "./schema/triggers.ts";
import type {
  MigrationBuilder,
  MigrationContext,
  SchemaRequirement,
} from "./types.ts";

type SchemaMigrationAfter = (context: MigrationContext) => Promise<void>;

const hasEntries = (values: readonly unknown[] | undefined): boolean =>
  (values?.length ?? 0) > 0;

const hasColumnRequirements = (requires: SchemaRequirement): boolean =>
  Object.values(requires.columns ?? {}).some(hasEntries);

/** The tables a migration's apply can touch: the ones it declares. An
 * incremental apply must never reach a table a later migration redefines.
 * The whole-schema apply there emits an ALTER the stored shape refuses, and
 * the upgrade stops before the redefining migration can drop that table. A
 * declared trigger's table and the tables its body reads are declared too:
 * the apply must leave them ready for syncTriggers to create the trigger. */
const declaredTables = (requires: SchemaRequirement): readonly string[] => {
  const tables = new Set([
    ...(requires.newTables ?? []),
    ...Object.keys(requires.columns ?? {}),
  ]);
  for (const trigger of TRIGGERS) {
    if (!(requires.triggers ?? []).includes(trigger.name)) continue;
    tables.add(trigger.table);
    for (const dependency of Object.keys(trigger.uses)) tables.add(dependency);
  }
  return [...tables];
};

const runSchemaSync = async (
  context: MigrationContext,
  requires: SchemaRequirement,
): Promise<void> => {
  if (hasEntries(requires.newTables) || hasColumnRequirements(requires)) {
    await context.applySchemaChanges({ tables: declaredTables(requires) });
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
 * A migration that owns no additive object — it carries `{}` requires and the
 * schema-hash guard covers the change — and just runs `work` in its `up()`.
 * The shared shape of the column-drop family below and of the data-only
 * migrations that rewrite or delete rows without touching the schema.
 */
export const bareSchemaMigration = (
  id: string,
  description: string,
  work: SchemaMigrationAfter,
): MigrationBuilder => schemaMigration(id, description, {}, work);

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
  bareSchemaMigration(id, description, async ({ recreateTable }) => {
    await recreateTable(table); // rebuild from SCHEMA, dropping the column
  });

/**
 * A migration that backfills data out of a column into another table and then
 * drops the column, gated on the column still being present so a re-run (after a
 * verify retry, a crash before the marker, or a fresh DB whose SCHEMA never had
 * the column) is a cheap no-op. `backfill` runs only when the column exists,
 * before the {@link recreateTable} rebuild that drops it. Owns no additive object
 * (`{}` requires); the schema-hash guard covers the drop. Shared by the pricing
 * migrations that move a legacy column into `listing_prices` then drop it.
 */
export const backfillDropColumnMigration = (
  id: string,
  table: string,
  column: string,
  description: string,
  backfill: (getDb: MigrationContext["getDb"]) => Promise<void>,
): MigrationBuilder =>
  bareSchemaMigration(id, description, async ({ getDb, recreateTable }) => {
    const info = await getDb().execute(`PRAGMA table_info(${table})`);
    if (!info.rows.some((row) => row.name === column)) return;
    await backfill(getDb);
    await recreateTable(table); // rebuild from SCHEMA, dropping the column
  });

/**
 * A column drop whose maintaining triggers still reference the dropped column, so
 * the bare {@link columnDropMigration} isn't enough: `CREATE TRIGGER IF NOT
 * EXISTS` won't replace the stale triggers, so they must be dropped before the
 * rebuild and let `syncTriggers` re-create the (now column-free) versions from
 * SCHEMA. Owns no additive object (`{}` requires); the schema-hash guard covers
 * the trigger-body change. Shared by the aggregate-column drops (listings.income,
 * modifiers.total_revenue) whose `up()` is otherwise identical.
 */
export const triggerRewriteDropMigration = (
  id: string,
  table: string,
  triggers: readonly string[],
  description: string,
): MigrationBuilder =>
  bareSchemaMigration(
    id,
    description,
    async ({ getDb, recreateTable, syncTriggers }) => {
      for (const trigger of triggers) {
        await getDb().execute(`DROP TRIGGER IF EXISTS ${trigger}`);
      }
      await recreateTable(table); // rebuild from SCHEMA, dropping the column
      await syncTriggers(); // re-create the column-free trigger bodies
    },
  );
