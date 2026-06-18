import { countRows } from "#shared/db/client.ts";
import { nowMs } from "#shared/now.ts";
import { getExistingColumns, runMigration } from "./schema-sync.ts";
import type {
  Migration,
  MigrationContext,
  SchemaRequirement,
} from "./types.ts";

const requires: SchemaRequirement = {
  absentTables: ["email_preferences"],
  indexes: [
    "idx_contact_prefs_unsubscribed",
    "idx_contact_prefs_last_activity",
  ],
  newTables: ["contact_preferences"],
};

const tableState = async (
  context: MigrationContext,
): Promise<"neither" | "legacy_only" | "target_only" | "both"> => {
  const [legacy, target] = await Promise.all([
    context.tableExists("email_preferences"),
    context.tableExists("contact_preferences"),
  ]);
  if (legacy && target) return "both";
  if (legacy) return "legacy_only";
  if (target) return "target_only";
  return "neither";
};

const renameLegacyTable = async (context: MigrationContext): Promise<void> => {
  const state = await tableState(context);
  if (state === "legacy_only") {
    await runMigration(
      "ALTER TABLE email_preferences RENAME TO contact_preferences",
    );
    return;
  }
  if (state !== "both") return;

  const [legacyRows, targetRows] = await Promise.all([
    countRows("email_preferences"),
    countRows("contact_preferences"),
  ]);
  if (targetRows === 0) {
    await runMigration("DROP TABLE contact_preferences");
    await runMigration(
      "ALTER TABLE email_preferences RENAME TO contact_preferences",
    );
    return;
  }
  if (legacyRows === 0) {
    await runMigration("DROP TABLE email_preferences");
    return;
  }
  throw new Error(
    "Cannot migrate email_preferences to contact_preferences: both tables contain rows",
  );
};

const renameLegacyHashColumn = async (): Promise<void> => {
  const columns = await getExistingColumns("contact_preferences");
  if (columns.has("email_hash") && !columns.has("contact_hash")) {
    await runMigration(
      "ALTER TABLE contact_preferences RENAME COLUMN email_hash TO contact_hash",
    );
  }
};

const backfillAndDropCreated = async (): Promise<void> => {
  const columns = await getExistingColumns("contact_preferences");
  if (!columns.has("created")) return;
  if (columns.has("last_activity")) {
    const migratedAtMs = nowMs();
    await runMigration(
      `UPDATE contact_preferences SET last_activity = ${migratedAtMs} WHERE last_activity = 0`,
    );
  }
  await runMigration("ALTER TABLE contact_preferences DROP COLUMN created");
};

export default (context: MigrationContext): Migration =>
  context.additive({
    description:
      "Generalise email_preferences into contact_preferences: rename email_hash to contact_hash, add visits and last_activity, backfill migrated last_activity to migration time, drop created, and add pruning/filter indexes",
    id: "2026-06-18_contact_preferences",
    requires,
    up: async () => {
      await renameLegacyTable(context);
      if (await context.tableExists("contact_preferences")) {
        await renameLegacyHashColumn();
      }
      await context.applySchemaChanges();
      await backfillAndDropCreated();
      await context.syncIndexes();
    },
  });
