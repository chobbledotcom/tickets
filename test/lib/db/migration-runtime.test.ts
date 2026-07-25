import type { InStatement, TransactionMode } from "@libsql/client";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { executeBatch, getDb, inPlaceholders } from "#shared/db/client.ts";
import { MigrationInProgressError } from "#shared/db/migrations/errors.ts";
import {
  DB_SCHEMA_HASH_KEY,
  LATEST_DB_UPDATE_KEY,
  MIGRATION_LOCK_KEY,
  SCHEMA_MIGRATIONS_TABLE,
} from "#shared/db/migrations/schema/version.ts";
import {
  fullSchemaCreateStatements,
  verifyCurrentAppSchema,
} from "#shared/db/migrations/schema-sync.ts";
import {
  applyMigrationWithRetry,
  initDb,
  invalidateInitDbCache,
  loadMigrations,
  MIGRATION_LOCK_TTL_MS,
  type Migration,
  rebuildWipedSchema,
  resetDatabase,
  SCHEMA_HASH,
  SCHEMA_TABLE_NAMES,
  VERIFY_RETRY_BACKOFF_MS,
  verifyMigrationWithRetry,
} from "#shared/db/migrations.ts";
import { createSession } from "#shared/db/sessions.ts";
import { settings } from "#shared/db/settings.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { withEnv } from "#test-utils/env.ts";
import { tempDir } from "#test-utils/files.ts";
import { resetTestSession, TEST_ADMIN_PASSWORD } from "#test-utils/internal.ts";
import { expectNtfyNotification, stubNtfyFetch } from "#test-utils/mocks.ts";
import { invalidateTestDbCache } from "#test-utils/test-state.ts";
import { withVirtualBackoff } from "#test-utils/virtual-time.ts";
import { markCurrentSchemaMigrationPending } from "./migration-test-helpers.ts";

type BatchStatement = Parameters<ReturnType<typeof getDb>["batch"]>[0][number];

describeWithEnv("db > migration runtime", { db: true }, () => {
  const TEST_DB_URL = "libsql://abc-tickets-spencer.lite.bunnydb.net";

  /** Stale the schema hash marker and set a migration_lock at the given
   *  timestamp, batched into one write round-trip. */
  const setStaleSchemaAndLock = async (heldSince: Date): Promise<void> => {
    await getDb().batch(
      [
        `UPDATE settings SET value = 'stale' WHERE key = '${DB_SCHEMA_HASH_KEY}'`,
        {
          args: [MIGRATION_LOCK_KEY, heldSince.toISOString()],
          sql: "INSERT INTO settings (key, value) VALUES (?, ?)",
        },
      ],
      "write",
    );
  };

  // Remove the migration_lock row and restore the db_schema_hash marker —
  // the shared cleanup step for every lock test's teardown.
  const restoreLockSettings = (): Promise<unknown> =>
    getDb().batch(
      [
        `DELETE FROM settings WHERE key = '${MIGRATION_LOCK_KEY}'`,
        {
          args: [SCHEMA_HASH],
          sql: `UPDATE settings SET value = ? WHERE key = '${DB_SCHEMA_HASH_KEY}'`,
        },
      ],
      "write",
    );

  const restoreLockTest = async () => {
    await restoreLockSettings();
  };

  const markMigrationsPending = async (
    migrationIds: string[],
  ): Promise<void> => {
    await executeBatch([
      {
        args: migrationIds,
        sql: `DELETE FROM ${SCHEMA_MIGRATIONS_TABLE} WHERE id IN (${inPlaceholders(migrationIds)})`,
      },
      {
        args: [],
        sql: `UPDATE settings SET value = 'stale' WHERE key IN ('${LATEST_DB_UPDATE_KEY}', '${DB_SCHEMA_HASH_KEY}')`,
      },
    ]);
    invalidateInitDbCache();
  };

  const statementSql = (statement: BatchStatement | InStatement): string =>
    Array.isArray(statement)
      ? statement[0]
      : typeof statement === "string"
        ? statement
        : statement.sql;

  const stubLockReleaseFailure = () => {
    const client = getDb();
    const execute = client.execute.bind(client);
    return stub(client, "execute", (statement: InStatement) =>
      statementSql(statement) ===
      "DELETE FROM settings WHERE key = ? AND value = ?"
        ? Promise.reject(new Error("lock release failed"))
        : execute(statement),
    );
  };

  const expectMigrationFailureWith = async (second: string): Promise<void> => {
    const error = await initDb().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors.map(String)).toEqual([
      "Error: migration work failed",
      `Error: ${second}`,
    ]);
  };

  describe("migration behaviour", () => {
    test("migrates an existing database without taking an inline backup", async () => {
      using tmpDir = tempDir();
      using _env = withEnv({ LOCAL_STORAGE_PATH: tmpDir.path });
      await getDb().execute(
        `UPDATE settings SET value = 'stale' WHERE key = '${DB_SCHEMA_HASH_KEY}'`,
      );
      await markCurrentSchemaMigrationPending();
      await initDb();

      // The migration completed...
      const result = await getDb().execute(
        `SELECT value FROM settings WHERE key = '${DB_SCHEMA_HASH_KEY}'`,
      );
      expect(result.rows[0]?.value).toBe(SCHEMA_HASH);

      // ...and no backup was written — backups are now taken out-of-band.
      const files = [...Deno.readDirSync(tmpDir.path)]
        .map((e) => e.name)
        .filter((n) => n.startsWith("backup-"));
      expect(files.length).toBe(0);
    });

    test("sends ntfy notification with DB_URL when migration lock is held", async () => {
      const { fetchStub, restore } = stubNtfyFetch({ DB_URL: TEST_DB_URL });
      using _env = restore;
      using _fetch = fetchStub;
      try {
        await setStaleSchemaAndLock(new Date());
        invalidateInitDbCache();

        await expect(initDb()).rejects.toThrow("migration_lock held");

        expectNtfyNotification(fetchStub, `E_DB_MIGRATION_LOCK ${TEST_DB_URL}`);
      } finally {
        await restoreLockTest();
      }
    });
  });

  describe("migration lock TTL", () => {
    test("fails fast when a concurrent migration holds the lock", async () => {
      const { fetchStub, restore } = stubNtfyFetch();
      using _env = restore;
      using _fetch = fetchStub;
      try {
        await setStaleSchemaAndLock(new Date());
        invalidateInitDbCache();

        await expect(initDb()).rejects.toThrow(MigrationInProgressError);
        invalidateInitDbCache();
        await expect(initDb()).rejects.toThrow("migration_lock held");

        expectNtfyNotification(fetchStub);
      } finally {
        await restoreLockTest();
      }
    });

    test("reclaims an expired lock so a stalled migration can complete", async () => {
      try {
        using _env = withEnv({
          LOCAL_STORAGE_PATH: undefined,
          STORAGE_ZONE_KEY: undefined,
          STORAGE_ZONE_NAME: undefined,
        });
        await setStaleSchemaAndLock(
          new Date(Date.now() - MIGRATION_LOCK_TTL_MS - 1000),
        );
        await markCurrentSchemaMigrationPending();

        await initDb();

        const result = await getDb().execute(
          `SELECT value FROM settings WHERE key = '${DB_SCHEMA_HASH_KEY}'`,
        );
        expect(result.rows[0]?.value).toBe(SCHEMA_HASH);
      } finally {
        await getDb().execute(
          `DELETE FROM settings WHERE key = '${MIGRATION_LOCK_KEY}'`,
        );
      }
    });

    test("keeps blocking while a lock is still within its TTL", async () => {
      try {
        await setStaleSchemaAndLock(
          new Date(Date.now() - MIGRATION_LOCK_TTL_MS / 2),
        );
        invalidateInitDbCache();

        await expect(initDb()).rejects.toThrow("migration_lock held");
      } finally {
        await restoreLockSettings();
      }
    });

    test("does not record completion or delete a successor lock after losing ownership", async () => {
      const migrations = await loadMigrations();
      const migration = migrations.at(-1)!;
      const originalVerify = migration.verify;
      const successorLock = `${new Date().toISOString()}|successor`;
      await markMigrationsPending([migration.id]);
      migration.verify = async () => {
        await originalVerify();
        await getDb().execute({
          args: [successorLock],
          sql: `UPDATE settings SET value = ? WHERE key = '${MIGRATION_LOCK_KEY}'`,
        });
      };

      try {
        await expect(initDb()).rejects.toThrow("lock ownership was lost");
        const lock = await getDb().execute(
          `SELECT value FROM settings WHERE key = '${MIGRATION_LOCK_KEY}'`,
        );
        expect(lock.rows[0]?.value).toBe(successorLock);
        const marker = await getDb().execute({
          args: [migration.id],
          sql: `SELECT id FROM ${SCHEMA_MIGRATIONS_TABLE} WHERE id = ?`,
        });
        expect(marker.rows).toHaveLength(0);
      } finally {
        migration.verify = originalVerify;
        await getDb().execute(
          `DELETE FROM settings WHERE key = '${MIGRATION_LOCK_KEY}'`,
        );
      }
    });

    test("surfaces a lock release failure after otherwise successful work", async () => {
      await getDb().execute(
        `UPDATE settings SET value = 'stale' WHERE key = '${DB_SCHEMA_HASH_KEY}'`,
      );
      invalidateInitDbCache();
      const executeStub = stubLockReleaseFailure();

      try {
        await expect(initDb()).rejects.toThrow("lock release failed");
      } finally {
        executeStub.restore();
        await restoreLockSettings();
      }
    });

    test("reports migration and lock release failures together", async () => {
      const migrations = await loadMigrations();
      const migration = migrations.at(-1)!;
      const originalUp = migration.up;
      await markMigrationsPending([migration.id]);
      migration.up = () => Promise.reject(new Error("migration work failed"));
      const executeStub = stubLockReleaseFailure();

      try {
        await expectMigrationFailureWith("lock release failed");
      } finally {
        executeStub.restore();
        migration.up = originalUp;
        await restoreLockSettings();
      }
    });

    test("reports migration and progress marker failures together", async () => {
      const migrations = await loadMigrations();
      const [completedMigration, failingMigration] = migrations.slice(-2);
      const originalUp = failingMigration!.up;
      await markMigrationsPending([
        completedMigration!.id,
        failingMigration!.id,
      ]);
      failingMigration!.up = () =>
        Promise.reject(new Error("migration work failed"));
      const client = getDb();
      const batch = client.batch.bind(client);
      const batchStub = stub(
        client,
        "batch",
        (statements: BatchStatement[], mode?: TransactionMode) =>
          statements.some((statement) =>
            statementSql(statement).includes("SET value = value"),
          )
            ? Promise.reject(new Error("progress marker failed"))
            : batch(statements, mode),
      );

      try {
        await expectMigrationFailureWith("progress marker failed");
      } finally {
        batchStub.restore();
        failingMigration!.up = originalUp;
        await restoreLockSettings();
      }
    });
  });

  describe("verify retry on read-your-writes lag", () => {
    const fakeMigration = (verify: () => Promise<void>): Migration => ({
      description: "fake migration for verify-retry tests",
      id: "fake-verify-retry",
      up: () => Promise.resolve(),
      verify,
    });

    test("retries a transient verify failure and then resolves", async () => {
      let attempts = 0;
      await withVirtualBackoff(() =>
        verifyMigrationWithRetry(
          fakeMigration(() => {
            attempts++;
            // Fail on the first two snapshots (stale schema), succeed on the third.
            return attempts < 3
              ? Promise.reject(
                  new Error("Migration verification failed: missing column(s)"),
                )
              : Promise.resolve();
          }),
        ),
      );
      expect(attempts).toBe(3);
    });

    test("rethrows after exhausting every retry", async () => {
      let attempts = 0;
      await expect(
        withVirtualBackoff(() =>
          verifyMigrationWithRetry(
            fakeMigration(() => {
              attempts++;
              return Promise.reject(new Error("genuine schema defect"));
            }),
          ),
        ),
      ).rejects.toThrow("genuine schema defect");
      // One initial attempt plus one per backoff entry.
      expect(attempts).toBe(VERIFY_RETRY_BACKOFF_MS.length + 1);
    });
  });

  describe("apply re-runs up() when verify keeps failing", () => {
    const fakeMigration = (overrides: Partial<Migration>): Migration => ({
      description: "fake migration for apply-retry tests",
      id: "fake-apply-retry",
      up: () => Promise.resolve(),
      verify: () => Promise.resolve(),
      ...overrides,
    });

    test("resolves a transient verify-lag without re-running up()", async () => {
      // Pure verify-lag: up() did its work, only verify()'s snapshot lagged.
      // up() must NOT be re-run (it may recopy large tables), so the cheap verify
      // retry alone resolves it.
      let upCalls = 0;
      let attempts = 0;
      await withVirtualBackoff(() =>
        applyMigrationWithRetry(
          fakeMigration({
            up: () => {
              upCalls++;
              return Promise.resolve();
            },
            verify: () => {
              attempts++;
              return attempts < 3
                ? Promise.reject(
                    new Error(
                      "Migration verification failed: missing column(s)",
                    ),
                  )
                : Promise.resolve();
            },
          }),
        ),
      );
      expect(attempts).toBe(3);
      expect(upCalls).toBe(1);
    });

    test("re-runs up() once when verify keeps failing, so a skipped index recovers", async () => {
      // Reproduces the production failure: up()'s syncIndexes ran against a
      // primary snapshot that lagged the table it had just created in the same
      // up(), so it silently skipped the index. Retrying verify() ALONE would
      // fail on every attempt because the index was never created; only re-running
      // up() (which now sees the table) creates it — which is why the failure
      // cleared on the next request. up() is re-run only after a full round of
      // verify retries has failed.
      let upCalls = 0;
      let indexCreated = false;
      await withVirtualBackoff(() =>
        applyMigrationWithRetry(
          fakeMigration({
            up: () => {
              upCalls++;
              // First up() skips the index (lagging snapshot); the second sees the
              // table and creates it.
              if (upCalls >= 2) indexCreated = true;
              return Promise.resolve();
            },
            verify: () =>
              indexCreated
                ? Promise.resolve()
                : Promise.reject(
                    new Error(
                      "Migration verification failed: missing index idx_system_notes_attendee_id",
                    ),
                  ),
          }),
        ),
      );
      // up() ran exactly twice — once initially, once to repair — never per retry.
      expect(upCalls).toBe(2);
      expect(indexCreated).toBe(true);
    });

    test("rethrows the original error after re-running up() once and still failing", async () => {
      let upCalls = 0;
      let verifyAttempts = 0;
      await expect(
        withVirtualBackoff(() =>
          applyMigrationWithRetry(
            fakeMigration({
              up: () => {
                upCalls++;
                return Promise.resolve();
              },
              verify: () => {
                verifyAttempts++;
                return Promise.reject(new Error("genuine schema defect"));
              },
            }),
          ),
        ),
      ).rejects.toThrow("genuine schema defect");
      // A genuine defect re-runs up() exactly once (the bounded repair), not once
      // per retry, and verifies across two full retry rounds.
      expect(upCalls).toBe(2);
      expect(verifyAttempts).toBe(2 * (VERIFY_RETRY_BACKOFF_MS.length + 1));
    });
  });

  describe("resetDatabase", () => {
    test("drops all tables", async () => {
      await createTestListing({
        maxAttendees: 50,
        name: "Test Listing",
        thankYouUrl: "https://example.com",
      });
      await createSession(
        "test-token",
        "test-csrf",
        Date.now() + 1000,
        null,
        1,
      );

      await resetDatabase();
      invalidateTestDbCache();

      const tablesResult = await getDb().execute(
        "SELECT name FROM sqlite_master WHERE type='table'",
      );
      const tableNames = tablesResult.rows.map((r) => r.name);
      expect(tableNames).not.toContain("listings");
      expect(tableNames).not.toContain("attendees");
      expect(tableNames).not.toContain("sessions");
      expect(tableNames).not.toContain("settings");
      expect(tableNames).not.toContain("login_attempts");
      expect(tableNames).not.toContain("processed_payments");
      expect(tableNames).not.toContain("activity_log");
    });

    test("can reinitialize database after reset", async () => {
      await resetDatabase();
      invalidateTestDbCache();
      // resetDatabase() now clears the session cache, so the pre-reset session
      // cookie is no longer valid. Clear the test session so getTestSession()
      // falls through to a fresh login after setup completes.
      resetTestSession();
      await initDb({ allowMissingSettings: true });

      await settings.setup.complete("testadmin", TEST_ADMIN_PASSWORD, "USD");
      const listing = await createTestListing({
        maxAttendees: 25,
        name: "New Listing",
        thankYouUrl: "https://example.com",
      });

      expect(listing.id).toBe(1);
      expect(listing.name).toBe("New Listing");
    });

    test("rebuildWipedSchema rebuilds a wiped database directly", async () => {
      // The restore path calls this straight after resetDatabase() — with no
      // initDb state check or schema snapshot in between — so it must produce
      // a complete, bootable schema purely from the declarative SCHEMA.
      await resetDatabase();
      invalidateTestDbCache();
      resetTestSession();

      await rebuildWipedSchema();

      // Every app-schema table, index, and trigger is present...
      await verifyCurrentAppSchema();
      // ...and the schema markers were written, so a normal boot treats the
      // database as fully migrated rather than throwing MissingSettingsTable.
      await initDb();

      await settings.setup.complete("testadmin", TEST_ADMIN_PASSWORD, "USD");
      const listing = await createTestListing({ name: "Fresh Schema Listing" });
      expect(listing.name).toBe("Fresh Schema Listing");
    });

    test("fullSchemaCreateStatements builds every table and index from the declaration alone", () => {
      const statements = fullSchemaCreateStatements();

      // One CREATE TABLE per schema table, in SCHEMA (FK-dependency) order.
      const createdTables = statements
        .map((sql) => sql.match(/^CREATE TABLE IF NOT EXISTS (\w+) /)?.[1])
        .filter((name) => name !== undefined);
      expect(createdTables).toEqual(SCHEMA_TABLE_NAMES);

      // Declared indexes ride along (spot-check a known one), and every
      // statement is IF NOT EXISTS so a replay can never fail.
      expect(
        statements.some((sql) =>
          sql.includes("CREATE INDEX IF NOT EXISTS idx_attendees_kind"),
        ),
      ).toBe(true);
      for (const sql of statements) {
        expect(sql).toContain("IF NOT EXISTS");
      }
    });
  });
});
