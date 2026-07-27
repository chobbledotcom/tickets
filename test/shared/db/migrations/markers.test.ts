import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getDb } from "#shared/db/client.ts";
import { acquireMigrationLock } from "#shared/db/migrations/lock.ts";
import {
  getAppliedMigrationIds,
  migrationMarkerStatement,
  recordMigrationBatch,
  writeSchemaMarkers,
} from "#shared/db/migrations/markers.ts";
import { MIGRATION_IDS } from "#shared/db/migrations/registry.ts";
import { SCHEMA_HASH } from "#shared/db/migrations/schema/index.ts";
import {
  DB_SCHEMA_HASH_KEY,
  LATEST_DB_UPDATE_KEY,
  LATEST_UPDATE,
  MIGRATION_LOCK_KEY,
  SCHEMA_MIGRATIONS_TABLE,
} from "#shared/db/migrations/schema/version.ts";
import type { Migration } from "#shared/db/migrations/types.ts";
import { describeWithEnv } from "#test-utils/db.ts";

describeWithEnv("db > migrations > markers", { db: true }, () => {
  const testMigration: Migration = {
    description: "marker test migration",
    id: "marker-test-migration",
    up: () => Promise.resolve(),
    verify: () => Promise.resolve(),
  };

  const settingsValue = async (key: string): Promise<string | null> => {
    const result = await getDb().execute({
      args: [key],
      sql: "SELECT value FROM settings WHERE key = ?",
    });
    return (result.rows[0]?.value as string) ?? null;
  };

  const staleSchemaMarkers = async (): Promise<void> => {
    await getDb().execute(
      `UPDATE settings SET value = 'stale' WHERE key IN ('${LATEST_DB_UPDATE_KEY}', '${DB_SCHEMA_HASH_KEY}')`,
    );
  };

  const forgetTestMigration = async (): Promise<void> => {
    await getDb().execute({
      args: [testMigration.id],
      sql: `DELETE FROM ${SCHEMA_MIGRATIONS_TABLE} WHERE id = ?`,
    });
  };

  test("the marker statement records the migration's own id and description", () => {
    const statement = migrationMarkerStatement(testMigration, "2026-07-27");

    expect(statement.args).toEqual([
      testMigration.id,
      testMigration.description,
      "2026-07-27",
    ]);
  });

  test("writing schema markers stamps this build's update and hash", async () => {
    await staleSchemaMarkers();

    await writeSchemaMarkers();

    expect(await settingsValue(LATEST_DB_UPDATE_KEY)).toBe(LATEST_UPDATE);
    expect(await settingsValue(DB_SCHEMA_HASH_KEY)).toBe(SCHEMA_HASH);
  });

  test("the applied ids are every migration a fully-migrated database ran", async () => {
    const applied = await getAppliedMigrationIds();

    expect(MIGRATION_IDS.filter((id) => !applied.has(id))).toEqual([]);
  });

  test("recording a finished batch stamps the schema and frees the lock", async () => {
    const lockToken = await acquireMigrationLock(false);
    try {
      await staleSchemaMarkers();

      await recordMigrationBatch([testMigration], true, lockToken!);

      expect((await getAppliedMigrationIds()).has(testMigration.id)).toBe(true);
      expect(await settingsValue(DB_SCHEMA_HASH_KEY)).toBe(SCHEMA_HASH);
      expect(await settingsValue(MIGRATION_LOCK_KEY)).toBeNull();
    } finally {
      await forgetTestMigration();
    }
  });

  test("recording an unfinished batch leaves the schema markers alone", async () => {
    const lockToken = await acquireMigrationLock(false);
    try {
      await staleSchemaMarkers();

      await recordMigrationBatch([testMigration], false, lockToken!);

      expect((await getAppliedMigrationIds()).has(testMigration.id)).toBe(true);
      // More migrations are still to come, so this build's schema is not
      // claimed yet.
      expect(await settingsValue(DB_SCHEMA_HASH_KEY)).toBe("stale");
    } finally {
      await forgetTestMigration();
      await writeSchemaMarkers();
    }
  });
});
