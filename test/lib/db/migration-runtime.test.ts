import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { getDb } from "#shared/db/client.ts";
import {
  initDb,
  invalidateInitDbCache,
  MIGRATION_LOCK_TTL_MS,
  type Migration,
  MigrationInProgressError,
  resetDatabase,
  SCHEMA_HASH,
  VERIFY_RETRY_BACKOFF_MS,
  verifyMigrationWithRetry,
} from "#shared/db/migrations.ts";
import { createSession } from "#shared/db/sessions.ts";
import { settings } from "#shared/db/settings.ts";
import {
  createTestListing,
  describeWithEnv,
  invalidateTestDbCache,
  setTestEnv,
  TEST_ADMIN_PASSWORD,
} from "#test-utils";
import { markCurrentSchemaMigrationPending } from "./migration-test-helpers.ts";

describeWithEnv("db > migration runtime", { db: true }, () => {
  describe("migration behaviour", () => {
    test("migrates an existing database without taking an inline backup", async () => {
      const tmpDir = Deno.makeTempDirSync();
      const restore = setTestEnv({ LOCAL_STORAGE_PATH: tmpDir });
      try {
        await getDb().execute(
          "UPDATE settings SET value = 'stale' WHERE key = 'db_schema_hash'",
        );
        await markCurrentSchemaMigrationPending();
        await initDb();

        // The migration completed...
        const result = await getDb().execute(
          "SELECT value FROM settings WHERE key = 'db_schema_hash'",
        );
        expect(result.rows[0]?.value).toBe(SCHEMA_HASH);

        // ...and no backup was written — backups are now taken out-of-band.
        const files = [...Deno.readDirSync(tmpDir)]
          .map((e) => e.name)
          .filter((n) => n.startsWith("backup-"));
        expect(files.length).toBe(0);
      } finally {
        restore();
        Deno.removeSync(tmpDir, { recursive: true });
      }
    });

    test("sends ntfy notification with DB_URL when migration lock is held", async () => {
      const restoreNtfy = setTestEnv({
        DB_URL: "libsql://abc-tickets-spencer.lite.bunnydb.net",
        NTFY_URL: "https://ntfy.sh/test-topic",
      });
      const fetchStub = stub(globalThis, "fetch", () =>
        Promise.resolve(new Response()),
      );
      try {
        await getDb().execute(
          "UPDATE settings SET value = 'stale' WHERE key = 'db_schema_hash'",
        );
        await getDb().execute({
          args: ["migration_lock", new Date().toISOString()],
          sql: "INSERT INTO settings (key, value) VALUES (?, ?)",
        });
        invalidateInitDbCache();

        await expect(initDb()).rejects.toThrow("migration_lock held");

        const ntfyCall = fetchStub.calls.find(
          (c) => c.args[0] === "https://ntfy.sh/test-topic",
        );
        expect(ntfyCall).toBeDefined();
        expect((ntfyCall!.args[1] as RequestInit).body).toBe(
          "E_DB_MIGRATION_LOCK libsql://abc-tickets-spencer.lite.bunnydb.net",
        );
      } finally {
        fetchStub.restore();
        restoreNtfy();
        await getDb().execute(
          "DELETE FROM settings WHERE key = 'migration_lock'",
        );
        await getDb().execute({
          args: [SCHEMA_HASH],
          sql: "UPDATE settings SET value = ? WHERE key = 'db_schema_hash'",
        });
      }
    });
  });

  describe("migration lock TTL", () => {
    const setLock = (heldSince: Date) =>
      getDb().execute({
        args: ["migration_lock", heldSince.toISOString()],
        sql: "INSERT INTO settings (key, value) VALUES (?, ?)",
      });

    test("fails fast when a concurrent migration holds the lock", async () => {
      const restore = setTestEnv({ NTFY_URL: "https://ntfy.sh/test-topic" });
      const fetchStub = stub(globalThis, "fetch", () =>
        Promise.resolve(new Response()),
      );
      try {
        await getDb().execute(
          "UPDATE settings SET value = 'stale' WHERE key = 'db_schema_hash'",
        );
        await setLock(new Date());
        invalidateInitDbCache();

        await expect(initDb()).rejects.toThrow(MigrationInProgressError);
        invalidateInitDbCache();
        await expect(initDb()).rejects.toThrow("migration_lock held");

        const ntfyCall = fetchStub.calls.find(
          (c) => c.args[0] === "https://ntfy.sh/test-topic",
        );
        expect(ntfyCall).toBeDefined();
      } finally {
        fetchStub.restore();
        restore();
        await getDb().execute(
          "DELETE FROM settings WHERE key = 'migration_lock'",
        );
        await getDb().execute({
          args: [SCHEMA_HASH],
          sql: "UPDATE settings SET value = ? WHERE key = 'db_schema_hash'",
        });
      }
    });

    test("reclaims an expired lock so a stalled migration can complete", async () => {
      const restore = setTestEnv({
        LOCAL_STORAGE_PATH: undefined,
        STORAGE_ZONE_KEY: undefined,
        STORAGE_ZONE_NAME: undefined,
      });
      try {
        await getDb().execute(
          "UPDATE settings SET value = 'stale' WHERE key = 'db_schema_hash'",
        );
        await markCurrentSchemaMigrationPending();
        await setLock(new Date(Date.now() - MIGRATION_LOCK_TTL_MS - 1000));

        await initDb();

        const result = await getDb().execute(
          "SELECT value FROM settings WHERE key = 'db_schema_hash'",
        );
        expect(result.rows[0]?.value).toBe(SCHEMA_HASH);
      } finally {
        restore();
        await getDb().execute(
          "DELETE FROM settings WHERE key = 'migration_lock'",
        );
      }
    });

    test("keeps blocking while a lock is still within its TTL", async () => {
      try {
        await getDb().execute(
          "UPDATE settings SET value = 'stale' WHERE key = 'db_schema_hash'",
        );
        await setLock(new Date(Date.now() - MIGRATION_LOCK_TTL_MS / 2));
        invalidateInitDbCache();

        await expect(initDb()).rejects.toThrow("migration_lock held");
      } finally {
        await getDb().execute(
          "DELETE FROM settings WHERE key = 'migration_lock'",
        );
        await getDb().execute({
          args: [SCHEMA_HASH],
          sql: "UPDATE settings SET value = ? WHERE key = 'db_schema_hash'",
        });
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
      await verifyMigrationWithRetry(
        fakeMigration(() => {
          attempts++;
          // Fail on the first two snapshots (stale schema), succeed on the third.
          return attempts < 3
            ? Promise.reject(
                new Error("Migration verification failed: missing column(s)"),
              )
            : Promise.resolve();
        }),
      );
      expect(attempts).toBe(3);
    });

    test("rethrows after exhausting every retry", async () => {
      let attempts = 0;
      await expect(
        verifyMigrationWithRetry(
          fakeMigration(() => {
            attempts++;
            return Promise.reject(new Error("genuine schema defect"));
          }),
        ),
      ).rejects.toThrow("genuine schema defect");
      // One initial attempt plus one per backoff entry.
      expect(attempts).toBe(VERIFY_RETRY_BACKOFF_MS.length + 1);
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
  });
});
