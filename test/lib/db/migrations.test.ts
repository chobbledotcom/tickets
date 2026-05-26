import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { backupFilename, backupTimestamp } from "#shared/db/backup.ts";
import { getDb } from "#shared/db/client.ts";
import { getAllEvents } from "#shared/db/events.ts";
import {
  initDb,
  LATEST_UPDATE,
  MIGRATION_LOCK_TTL_MS,
  resetDatabase,
  SCHEMA_HASH,
} from "#shared/db/migrations.ts";
import { createSession } from "#shared/db/sessions.ts";
import { settings } from "#shared/db/settings.ts";
import { uploadRaw } from "#shared/storage.ts";
import {
  createTestEvent,
  describeWithEnv,
  installUrlHandler,
  invalidateTestDbCache,
  setTestEnv,
  TEST_ADMIN_PASSWORD,
  withFetchMock,
} from "#test-utils";

describeWithEnv("db > migrations", { db: true }, () => {
  describe("initDb version check", () => {
    test("initDb stores latest_db_update in settings", async () => {
      const result = await getDb().execute(
        "SELECT value FROM settings WHERE key = 'latest_db_update'",
      );
      expect(result.rows[0]?.value).toBe(LATEST_UPDATE);
    });

    test("initDb stores db_schema_hash in settings", async () => {
      const result = await getDb().execute(
        "SELECT value FROM settings WHERE key = 'db_schema_hash'",
      );
      expect(result.rows[0]?.value).toBe(SCHEMA_HASH);
    });

    test("initDb re-runs when schema hash changes", async () => {
      await getDb().execute(
        "UPDATE settings SET value = 'stale' WHERE key = 'db_schema_hash'",
      );

      await initDb();

      const result = await getDb().execute(
        "SELECT value FROM settings WHERE key = 'db_schema_hash'",
      );
      expect(result.rows[0]?.value).toBe(SCHEMA_HASH);
    });

    test("initDb can be called multiple times safely", async () => {
      await initDb();

      const events = await getAllEvents();
      expect(events).toEqual([]);
    });

    test("initDb bails early when database is up to date", async () => {
      const startTime = performance.now();
      await initDb();
      const duration = performance.now() - startTime;

      expect(duration).toBeLessThan(100);
    });

    test("initDb drops legacy indexes not in declarative schema", async () => {
      await getDb().execute(
        `CREATE INDEX IF NOT EXISTS
         idx_attendees_legacy_created
         ON attendees(created)`,
      );

      const before = await getDb().execute(
        `SELECT name FROM sqlite_master
         WHERE type = 'index'
           AND name = 'idx_attendees_legacy_created'`,
      );
      expect(before.rows.length).toBe(1);

      await getDb().execute(
        "UPDATE settings SET value = 'stale' WHERE key = 'db_schema_hash'",
      );
      await initDb();

      const after = await getDb().execute(
        `SELECT name FROM sqlite_master
         WHERE type = 'index'
           AND name = 'idx_attendees_legacy_created'`,
      );
      expect(after.rows.length).toBe(0);
    });
  });

  describe("pre-migration backup", () => {
    test("creates backup before migrating existing database when storage is enabled", async () => {
      const tmpDir = Deno.makeTempDirSync();
      const restore = setTestEnv({ LOCAL_STORAGE_PATH: tmpDir });
      try {
        await getDb().execute(
          "UPDATE settings SET value = 'stale' WHERE key = 'db_schema_hash'",
        );
        await initDb();

        const files = [...Deno.readDirSync(tmpDir)]
          .map((e) => e.name)
          .filter((n) => n.startsWith("backup-") && n.endsWith(".zip"));
        expect(files.length).toBe(1);
      } finally {
        restore();
        Deno.removeSync(tmpDir, { recursive: true });
      }
    });

    test("skips pre-migration backup when a recent backup already exists", async () => {
      const tmpDir = Deno.makeTempDirSync();
      const restore = setTestEnv({ LOCAL_STORAGE_PATH: tmpDir });
      try {
        const existing = backupFilename(backupTimestamp());
        await uploadRaw(new Uint8Array([1]), existing);

        await getDb().execute(
          "UPDATE settings SET value = 'stale' WHERE key = 'db_schema_hash'",
        );
        await initDb();

        const files = [...Deno.readDirSync(tmpDir)]
          .map((e) => e.name)
          .filter((n) => n.startsWith("backup-") && n.endsWith(".zip"));
        expect(files).toEqual([existing]);
      } finally {
        restore();
        Deno.removeSync(tmpDir, { recursive: true });
      }
    });

    test("skips backup on brand-new database", async () => {
      const tmpDir = Deno.makeTempDirSync();
      const restore = setTestEnv({ LOCAL_STORAGE_PATH: tmpDir });
      try {
        await resetDatabase();
        invalidateTestDbCache();
        await initDb();

        const files = [...Deno.readDirSync(tmpDir)]
          .map((e) => e.name)
          .filter((n) => n.startsWith("backup-") && n.endsWith(".zip"));
        expect(files.length).toBe(0);
      } finally {
        restore();
        Deno.removeSync(tmpDir, { recursive: true });
      }
    });

    test("skips backup when storage is not enabled", async () => {
      const restore = setTestEnv({
        LOCAL_STORAGE_PATH: undefined,
        STORAGE_ZONE_KEY: undefined,
        STORAGE_ZONE_NAME: undefined,
      });
      try {
        await getDb().execute(
          "UPDATE settings SET value = 'stale' WHERE key = 'db_schema_hash'",
        );
        await initDb();

        const result = await getDb().execute(
          "SELECT value FROM settings WHERE key = 'db_schema_hash'",
        );
        expect(result.rows[0]?.value).toBe(SCHEMA_HASH);
      } finally {
        restore();
      }
    });

    test("blocks migration when backup fails", async () => {
      const restore = setTestEnv({
        LOCAL_STORAGE_PATH: undefined,
        STORAGE_ZONE_KEY: "fake-key",
        STORAGE_ZONE_NAME: "fake-zone",
      });
      try {
        await getDb().execute(
          "UPDATE settings SET value = 'stale' WHERE key = 'db_schema_hash'",
        );
        await withFetchMock(async (originalFetch) => {
          installUrlHandler(originalFetch, (url) =>
            url.includes("bunnycdn.com") || url.includes("b-cdn.net")
              ? Promise.reject(new Error("forced upload failure"))
              : null,
          );
          await expect(initDb()).rejects.toThrow();
        });

        const result = await getDb().execute(
          "SELECT value FROM settings WHERE key = 'db_schema_hash'",
        );
        expect(result.rows[0]?.value).toBe("stale");
      } finally {
        restore();
        await getDb().execute(
          "DELETE FROM settings WHERE key = 'migration_lock'",
        );
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

  describe("resetDatabase", () => {
    test("drops all tables", async () => {
      await createTestEvent({
        maxAttendees: 50,
        name: "Test Event",
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
      expect(tableNames).not.toContain("events");
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
      await initDb();

      await settings.setup.complete("testadmin", TEST_ADMIN_PASSWORD, "USD");
      const event = await createTestEvent({
        maxAttendees: 25,
        name: "New Event",
        thankYouUrl: "https://example.com",
      });

      expect(event.id).toBe(1);
      expect(event.name).toBe("New Event");
    });
  });
});
