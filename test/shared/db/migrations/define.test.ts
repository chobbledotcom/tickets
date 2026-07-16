import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getDb } from "#shared/db/client.ts";
import {
  backfillDropColumnMigration,
  schemaMigration,
} from "#shared/db/migrations/define.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { buildMigrationContext } from "#test-utils/migrations.ts";

describeWithEnv("db > migration definitions", { db: true }, () => {
  test("runs each schema step required by the migration", async () => {
    const calls: string[] = [];
    const migration = schemaMigration("test", "Test migration", {
      indexes: ["test_index"],
      newTables: ["test_table"],
      triggers: ["test_trigger"],
    })(
      buildMigrationContext({
        applySchemaChanges: () => {
          calls.push("schema");
          return Promise.resolve();
        },
        syncIndexes: () => {
          calls.push("indexes");
          return Promise.resolve();
        },
        syncTriggers: () => {
          calls.push("triggers");
          return Promise.resolve();
        },
      }),
    );

    await migration.up();

    expect(calls).toEqual(["schema", "indexes", "triggers"]);
  });

  test("applies a migration that owns only an added column", async () => {
    let applied = false;
    const migration = schemaMigration("test", "Test migration", {
      columns: { attendees: ["new_column"] },
    })(
      buildMigrationContext({
        applySchemaChanges: () => {
          applied = true;
          return Promise.resolve();
        },
      }),
    );

    await migration.up();

    expect(applied).toBe(true);
  });

  test("does not backfill or rebuild when the dropped column is already absent", async () => {
    let columnChecks = 0;
    let backfills = 0;
    let rebuilds = 0;
    const migration = backfillDropColumnMigration(
      "test",
      "attendees",
      "missing_column",
      "Test migration",
      () => {
        backfills += 1;
        return Promise.resolve();
      },
    )(
      buildMigrationContext({
        getDb: () => {
          columnChecks += 1;
          return getDb();
        },
        recreateTable: () => {
          rebuilds += 1;
          return Promise.resolve();
        },
      }),
    );

    await migration.up();

    expect(columnChecks).toBe(1);
    expect(backfills).toBe(0);
    expect(rebuilds).toBe(0);
  });
});
