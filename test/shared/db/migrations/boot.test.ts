import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getDb } from "#shared/db/client.ts";
import { MIGRATION_IDS } from "#shared/db/migrations/registry.ts";
import {
  initDb,
  invalidateInitDbCache,
  LATEST_UPDATE,
  rebuildWipedSchema,
  resetDatabase,
  SCHEMA_HASH,
} from "#shared/db/migrations.ts";
import { runWithQueryLogContext } from "#shared/db/query-log.ts";
import { setBuildCommitForTest } from "#shared/update.ts";
import {
  markCurrentSchemaMigrationPending,
  markMigrationsForRerun,
} from "#test/test-utils/db/migration-test-helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { debugMessages, useDebugLogSpy } from "#test-utils/debug-log.ts";
import {
  appliedMigrationIds,
  settingsValueOrNull,
} from "#test-utils/migrations.ts";
import { stubNtfyFetch } from "#test-utils/mocks.ts";
import { invalidateTestDbCache } from "#test-utils/test-state.ts";

describeWithEnv(
  "db > migrations > boot messages and batching",
  { db: true },
  () => {
    const debugSpy = useDebugLogSpy();

    const debugLines = (): string[] => debugMessages(debugSpy()).map(String);

    /** Leave one marker as this build's and stale the other, so only a
     *  database matching on BOTH counts can read as up to date. */
    const staleOneMarker = async (
      staleKey: string,
      freshKey: string,
      freshValue: string,
    ): Promise<void> => {
      await getDb().batch(
        [
          {
            args: [staleKey],
            sql: "UPDATE settings SET value = 'stale' WHERE key = ?",
          },
          {
            args: [freshValue, freshKey],
            sql: "UPDATE settings SET value = ? WHERE key = ?",
          },
        ],
        "write",
      );
      invalidateInitDbCache();
    };

    test("a marker that matches only halfway still needs work", async () => {
      // The update marker is this build's, but the schema hash is not: the
      // database is not up to date, so the boot must repair the markers.
      await staleOneMarker("db_schema_hash", "latest_db_update", LATEST_UPDATE);

      await initDb();

      expect(await settingsValueOrNull("db_schema_hash")).toBe(SCHEMA_HASH);
    });

    test("the other half-matching marker needs work too", async () => {
      await staleOneMarker("latest_db_update", "db_schema_hash", SCHEMA_HASH);

      await initDb();

      expect(await settingsValueOrNull("latest_db_update")).toBe(LATEST_UPDATE);
    });

    test("a single outstanding migration is run, not assumed applied", async () => {
      await markCurrentSchemaMigrationPending();
      await getDb().execute(
        "UPDATE settings SET value = 'stale' WHERE key = 'db_schema_hash'",
      );
      invalidateInitDbCache();

      await initDb();

      expect(await appliedMigrationIds()).toEqual([...MIGRATION_IDS].sort());
      expect(debugLines()).toContain("[Migration] Updating version marker...");
    });

    test("a fresh database says it is starting from the current schema", async () => {
      await resetDatabase();
      invalidateTestDbCache();

      await initDb({ allowMissingSettings: true });

      expect(debugLines()).toContain(
        "[Migration] Initializing fresh database from current schema",
      );
    });

    test("outside a request, the build's own commit is stored before boot returns", async () => {
      await resetDatabase();
      invalidateTestDbCache();
      setBuildCommitForTest("abc1234");
      try {
        await initDb({ allowMissingSettings: true });

        // Nothing else waits for this write, so boot must not return early.
        expect(await settingsValueOrNull("current_script_commit")).toBe(
          "abc1234",
        );
      } finally {
        setBuildCommitForTest(null);
      }
    });

    test("a rebuild after a wipe says so", async () => {
      await resetDatabase();
      invalidateTestDbCache();

      await rebuildWipedSchema();
      // Restore the shared database before asserting, so a failed assertion
      // does not leave the tests after this one on a half-built schema.
      await initDb();

      expect(debugLines()).toContain(
        "[Migration] Rebuilding wiped database from current schema",
      );
    });

    test("only four migrations run per request when the request budget applies", async () => {
      await markMigrationsForRerun();

      try {
        await runWithQueryLogContext(async () => {
          await expect(initDb()).rejects.toThrow(
            "Database update is continuing on the next request.",
          );
        });

        expect((await appliedMigrationIds()).length).toBe(4);
        expect(debugLines()).toContain(
          "[Migration] Recorded 4 migrations; continuing on the next request...",
        );
      } finally {
        // Leave the database fully migrated for the tests that follow.
        invalidateInitDbCache();
        await markMigrationsForRerun();
        await initDb();
      }
    });

    /** Hold a fresh migration lock, boot with the given DB_URL, and report
     *  every ntfy body the failed boot sent. */
    const bootWithLockHeld = async (
      dbUrl: string | undefined,
    ): Promise<{ bodies: string[]; error: unknown }> => {
      const { fetchStub, restore } = stubNtfyFetch({ DB_URL: dbUrl });
      using _env = restore;
      using _fetch = fetchStub;
      try {
        await getDb().batch(
          [
            "UPDATE settings SET value = 'stale' WHERE key = 'db_schema_hash'",
            {
              args: ["migration_lock", new Date().toISOString()],
              sql: "INSERT INTO settings (key, value) VALUES (?, ?)",
            },
          ],
          "write",
        );
        invalidateInitDbCache();

        const error = await initDb().catch((caught: unknown) => caught);
        return {
          bodies: fetchStub.calls.map((call) =>
            String((call.args[1] as { body?: string })?.body),
          ),
          error,
        };
      } finally {
        await getDb().batch(
          [
            "DELETE FROM settings WHERE key = 'migration_lock'",
            {
              args: [SCHEMA_HASH],
              sql: "UPDATE settings SET value = ? WHERE key = 'db_schema_hash'",
            },
          ],
          "write",
        );
        invalidateInitDbCache();
      }
    };

    test("a held lock says so, and how long it is honoured", async () => {
      const { error } = await bootWithLockHeld(undefined);

      expect(String(error)).toContain(
        "Database migration is already in progress (migration_lock held).",
      );
      expect(String(error)).toContain(
        "reclaimed automatically after 2 minutes",
      );
    });

    test("a held lock names an unset database as unknown", async () => {
      const { bodies } = await bootWithLockHeld(undefined);

      expect(
        bodies.some((body) => body.endsWith("E_DB_MIGRATION_LOCK unknown")),
      ).toBe(true);
    });

    test("a held lock reports a blank database name as blank", async () => {
      // An empty DB_URL is a real, if odd, setting — it is not missing, so it
      // is not reported as "unknown".
      const { bodies } = await bootWithLockHeld("");

      expect(bodies.some((body) => body.endsWith("E_DB_MIGRATION_LOCK "))).toBe(
        true,
      );
    });

    test("one missing marker is a database to update, not a blank one", async () => {
      // Only one of the two markers is gone: the database has been set up, so
      // the boot must repair it rather than treat it as uninitialized.
      await getDb().execute(
        "DELETE FROM settings WHERE key = 'db_schema_hash'",
      );
      invalidateInitDbCache();

      await initDb();

      expect(await settingsValueOrNull("db_schema_hash")).toBe(SCHEMA_HASH);
      expect(await settingsValueOrNull("latest_db_update")).toBe(LATEST_UPDATE);
    });
  },
);
