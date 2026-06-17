import {
  type Client,
  createClient,
  type ResultSet,
  type TransactionMode,
} from "@libsql/client";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { backupFilename, backupTimestamp } from "#shared/db/backup.ts";
import { getDb, setDb } from "#shared/db/client.ts";
import { getAllListings } from "#shared/db/listings.ts";
import {
  initDb,
  invalidateInitDbCache,
  LATEST_UPDATE,
  MIGRATION_IDS,
  MIGRATION_LOCK_TTL_MS,
  MigrationInProgressError,
  MissingSettingsTableError,
  renameEmailPrefsToContactPrefs,
  renameEventsToListings,
  resetDatabase,
  SCHEMA_HASH,
} from "#shared/db/migrations.ts";
import { createSession } from "#shared/db/sessions.ts";
import { settings } from "#shared/db/settings.ts";
import { uploadRaw } from "#shared/storage.ts";
import {
  createTestListing,
  describeWithEnv,
  installUrlHandler,
  invalidateTestDbCache,
  setTestEnv,
  TEST_ADMIN_PASSWORD,
  withFetchMock,
} from "#test-utils";

describeWithEnv("db > migrations", { db: true }, () => {
  const markCurrentSchemaMigrationPending = () => {
    // Clearing recorded history must also clear the per-isolate ready cache,
    // otherwise initDb never re-inspects this client.
    invalidateInitDbCache();
    return getDb().execute("DROP TABLE IF EXISTS schema_migrations");
  };

  describe("initDb version check", () => {
    const resultSet = (
      rows: Array<Record<string, unknown>>,
      rowsAffected = 0,
    ): ResultSet => ({
      columns: [],
      columnTypes: [],
      lastInsertRowid: undefined,
      rows: rows as unknown as ResultSet["rows"],
      rowsAffected,
      toJSON: () => ({}),
    });

    const mockClient = (execute: Client["execute"]): Client =>
      ({
        batch: (_statements: never[], _mode?: TransactionMode) =>
          Promise.reject(new Error("unexpected batch")),
        close: () => undefined,
        execute,
        executeMultiple: () =>
          Promise.reject(new Error("unexpected executeMultiple")),
        migrate: () => Promise.reject(new Error("unexpected migrate")),
        protocol: "file",
        sync: () => Promise.resolve(),
        transaction: () => Promise.reject(new Error("unexpected transaction")),
      }) as unknown as Client;

    const settingsTableExists = async (): Promise<boolean> => {
      const result = await getDb().execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='settings'",
      );
      return result.rows.length > 0;
    };

    const tableExists = async (table: string): Promise<boolean> => {
      const result = await getDb().execute({
        args: [table],
        sql: "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
      });
      return result.rows.length > 0;
    };

    const createEmptySettingsTable = () =>
      getDb().execute(
        "CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
      );

    const schemaMarkerKeys = async (): Promise<string[]> => {
      const result = await getDb().execute(
        "SELECT key FROM settings WHERE key IN ('latest_db_update', 'db_schema_hash') ORDER BY key",
      );
      return result.rows.map((row) => String(row.key));
    };

    const schemaMigrationsTableExists = async (): Promise<boolean> => {
      const result = await getDb().execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'",
      );
      return result.rows.length > 0;
    };

    const appliedMigrationIds = async (): Promise<string[]> => {
      const result = await getDb().execute(
        "SELECT id FROM schema_migrations ORDER BY id",
      );
      return result.rows.map((row) => String(row.id));
    };

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

    test("initDb stores named migration history", async () => {
      expect(await appliedMigrationIds()).toEqual([...MIGRATION_IDS].sort());
    });

    test("initDb baselines current databases without schema_migrations", async () => {
      await getDb().execute("DROP TABLE schema_migrations");
      invalidateInitDbCache();

      await initDb();

      expect(await schemaMigrationsTableExists()).toBe(true);
      expect(await appliedMigrationIds()).toEqual([...MIGRATION_IDS].sort());
    });

    test("initDb restores stale markers after a crash between recording migrations and writing markers", async () => {
      // Crash state: all named migrations recorded in schema_migrations,
      // but the isolate died before refreshing the settings markers.
      await getDb().execute(
        "UPDATE settings SET value = 'stale' WHERE key = 'db_schema_hash'",
      );
      await getDb().execute(
        "UPDATE settings SET value = 'stale' WHERE key = 'latest_db_update'",
      );
      invalidateInitDbCache();

      await initDb();

      const result = await getDb().execute(
        "SELECT key, value FROM settings WHERE key IN ('latest_db_update', 'db_schema_hash') ORDER BY key",
      );
      expect(result.rows.map((row) => [row.key, row.value])).toEqual([
        ["db_schema_hash", SCHEMA_HASH],
        ["latest_db_update", LATEST_UPDATE],
      ]);
      const lock = await getDb().execute(
        "SELECT 1 FROM settings WHERE key = 'migration_lock'",
      );
      expect(lock.rows.length).toBe(0);
    });

    test("initDb fails without rewriting markers when the schema does not match and no migration is pending", async () => {
      // A SCHEMA change deployed without a named migration: the hash is
      // stale, nothing is pending, and verification finds the mismatch.
      await getDb().execute("DROP INDEX idx_listings_slug_index");
      await getDb().execute(
        "UPDATE settings SET value = 'stale' WHERE key = 'db_schema_hash'",
      );
      invalidateInitDbCache();

      await expect(initDb()).rejects.toThrow(
        "must ship with a new entry in MIGRATIONS",
      );

      const result = await getDb().execute(
        "SELECT value FROM settings WHERE key = 'db_schema_hash'",
      );
      expect(result.rows[0]?.value).toBe("stale");
      const lock = await getDb().execute(
        "SELECT 1 FROM settings WHERE key = 'migration_lock'",
      );
      expect(lock.rows.length).toBe(0);
    });

    test("initDb can be called multiple times safely", async () => {
      await initDb();

      const listings = await getAllListings();
      expect(listings).toEqual([]);
    });

    test("initDb bails early when database is up to date", async () => {
      const startTime = performance.now();
      await initDb();
      const duration = performance.now() - startTime;

      expect(duration).toBeLessThan(100);
    });

    test("initDb does not treat transient settings read failures as a new database", async () => {
      const restore = setTestEnv({ NTFY_URL: "https://ntfy.sh/test-topic" });
      const fetchStub = stub(globalThis, "fetch", () =>
        Promise.resolve(new Response()),
      );
      setDb(
        mockClient((statement) => {
          const sql = typeof statement === "string" ? statement : statement.sql;
          if (sql.includes("FROM settings")) {
            return Promise.reject(new Error("temporary libsql read failure"));
          }
          return Promise.reject(
            new Error(`unexpected migration query: ${sql}`),
          );
        }),
      );
      try {
        await expect(initDb()).rejects.toThrow("temporary libsql read failure");
        const ntfyCall = fetchStub.calls.find(
          (c) => c.args[0] === "https://ntfy.sh/test-topic",
        );
        expect(ntfyCall).toBeUndefined();
      } finally {
        fetchStub.restore();
        restore();
        setDb(null);
      }
    });

    test("initDb does not treat transient lock write failures as an acquired lock", async () => {
      const restore = setTestEnv({ NTFY_URL: "https://ntfy.sh/test-topic" });
      const fetchStub = stub(globalThis, "fetch", () =>
        Promise.resolve(new Response()),
      );
      setDb(
        mockClient((statement) => {
          const sql = typeof statement === "string" ? statement : statement.sql;
          if (sql.includes("FROM settings")) {
            return Promise.resolve(
              resultSet([
                { key: "latest_db_update", value: "stale" },
                { key: "db_schema_hash", value: "stale" },
              ]),
            );
          }
          if (sql.includes("INSERT INTO settings")) {
            return Promise.reject(new Error("temporary libsql write failure"));
          }
          return Promise.reject(
            new Error(`unexpected migration query: ${sql}`),
          );
        }),
      );
      try {
        await expect(initDb()).rejects.toThrow(
          "temporary libsql write failure",
        );
        const ntfyCall = fetchStub.calls.find(
          (c) => c.args[0] === "https://ntfy.sh/test-topic",
        );
        expect(ntfyCall).toBeUndefined();
      } finally {
        fetchStub.restore();
        restore();
        setDb(null);
      }
    });

    test("initDb does not mistake another missing table for a missing settings table", async () => {
      setDb(
        mockClient((statement) => {
          const sql = typeof statement === "string" ? statement : statement.sql;
          if (sql.includes("FROM settings")) {
            return Promise.reject(new Error("no such table: user_settings"));
          }
          return Promise.reject(
            new Error(`unexpected migration query: ${sql}`),
          );
        }),
      );
      try {
        const error = await initDb().catch((e: unknown) => e);
        expect(error).not.toBeInstanceOf(MissingSettingsTableError);
        expect(String(error)).toContain("no such table: user_settings");
      } finally {
        setDb(null);
      }
    });

    test("initDb recognizes a schema-qualified missing settings table error", async () => {
      setDb(
        mockClient((statement) => {
          const sql = typeof statement === "string" ? statement : statement.sql;
          if (sql.includes("FROM settings")) {
            return Promise.reject(new Error("no such table: main.settings"));
          }
          return Promise.reject(
            new Error(`unexpected migration query: ${sql}`),
          );
        }),
      );
      try {
        await expect(initDb()).rejects.toBeInstanceOf(
          MissingSettingsTableError,
        );
      } finally {
        setDb(null);
      }
    });

    test("initDb refuses to bootstrap a fresh database by default", async () => {
      await resetDatabase();
      invalidateTestDbCache();

      await expect(initDb()).rejects.toBeInstanceOf(MissingSettingsTableError);

      expect(await settingsTableExists()).toBe(false);
    });

    test("initDb refuses to bootstrap an empty settings table by default", async () => {
      await resetDatabase();
      invalidateTestDbCache();
      await createEmptySettingsTable();

      await expect(initDb()).rejects.toThrow("settings table is uninitialized");

      expect(await settingsTableExists()).toBe(true);
      expect(await tableExists("listings")).toBe(false);
      expect(await schemaMarkerKeys()).toEqual([]);
    });

    test("initDb bootstraps a missing settings table when explicitly allowed", async () => {
      await resetDatabase();
      invalidateTestDbCache();

      await initDb({ allowMissingSettings: true });

      expect(await settingsTableExists()).toBe(true);
      expect(await schemaMarkerKeys()).toEqual([
        "db_schema_hash",
        "latest_db_update",
      ]);
      expect(await appliedMigrationIds()).toEqual([...MIGRATION_IDS].sort());
    });

    test("initDb bootstraps an empty settings table when explicitly allowed", async () => {
      await resetDatabase();
      invalidateTestDbCache();
      await createEmptySettingsTable();

      await initDb({ allowMissingSettings: true });

      expect(await settingsTableExists()).toBe(true);
      expect(await tableExists("listings")).toBe(true);
      expect(await schemaMarkerKeys()).toEqual([
        "db_schema_hash",
        "latest_db_update",
      ]);
      expect(await appliedMigrationIds()).toEqual([...MIGRATION_IDS].sort());
    });

    test("named legacy migration drops legacy indexes not in declarative schema", async () => {
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
      await markCurrentSchemaMigrationPending();
      await initDb();

      const after = await getDb().execute(
        `SELECT name FROM sqlite_master
         WHERE type = 'index'
           AND name = 'idx_attendees_legacy_created'`,
      );
      expect(after.rows.length).toBe(0);
    });

    test("named legacy migration drops legacy triggers not in declarative schema", async () => {
      await getDb().execute(
        `CREATE TRIGGER IF NOT EXISTS trg_legacy_noop
         AFTER INSERT ON attendees
         FOR EACH ROW BEGIN SELECT 1; END`,
      );

      const before = await getDb().execute(
        `SELECT name FROM sqlite_master
         WHERE type = 'trigger' AND name = 'trg_legacy_noop'`,
      );
      expect(before.rows.length).toBe(1);

      await getDb().execute(
        "UPDATE settings SET value = 'stale' WHERE key = 'db_schema_hash'",
      );
      await markCurrentSchemaMigrationPending();
      await initDb();

      const after = await getDb().execute(
        `SELECT name FROM sqlite_master
         WHERE type = 'trigger' AND name = 'trg_legacy_noop'`,
      );
      expect(after.rows.length).toBe(0);
    });
  });

  describe("renameEventsToListings (legacy event → listing upgrade)", () => {
    const columnNames = async (table: string): Promise<string[]> => {
      const result = await getDb().execute(
        `SELECT name FROM pragma_table_info('${table}')`,
      );
      return result.rows.map((r) => String(r.name));
    };

    const tableNames = async (): Promise<Set<string>> => {
      const result = await getDb().execute(
        "SELECT name FROM sqlite_master WHERE type = 'table'",
      );
      return new Set(result.rows.map((r) => String(r.name)));
    };

    // Simulate a legacy database by renaming the fully-formed current tables
    // back to their historical "event" names (so every column is present, as
    // it would be in production) and then asserting the migration restores the
    // "listing" names without losing data.
    const downgradeToLegacyNames = () =>
      getDb().batch(
        [
          "ALTER TABLE listings RENAME COLUMN listing_type TO event_type",
          "ALTER TABLE listings RENAME TO events",
          "ALTER TABLE listing_attendees RENAME COLUMN listing_id TO event_id",
          "ALTER TABLE listing_attendees RENAME TO event_attendees",
          "ALTER TABLE listing_questions RENAME COLUMN listing_id TO event_id",
          "ALTER TABLE listing_questions RENAME TO event_questions",
          "ALTER TABLE activity_log RENAME COLUMN listing_id TO event_id",
          "ALTER TABLE built_sites RENAME COLUMN assigned_listing_id TO assigned_event_id",
        ],
        "write",
      );

    test("renames legacy tables and columns while preserving rows", async () => {
      await createTestListing();
      await downgradeToLegacyNames();

      await renameEventsToListings();

      const tables = await tableNames();
      expect(tables.has("listings")).toBe(true);
      expect(tables.has("events")).toBe(false);
      expect(tables.has("listing_attendees")).toBe(true);
      expect(tables.has("listing_questions")).toBe(true);

      expect(await columnNames("listings")).toContain("listing_type");
      expect(await columnNames("listing_attendees")).toContain("listing_id");
      expect(await columnNames("listing_questions")).toContain("listing_id");
      expect(await columnNames("activity_log")).toContain("listing_id");
      expect(await columnNames("built_sites")).toContain("assigned_listing_id");

      // The seeded row survives the table/column renames intact.
      const listings = await getAllListings();
      expect(listings.length).toBe(1);
    });

    test("skips column renames for tables that do not exist", async () => {
      await downgradeToLegacyNames();
      // Drop a table whose column rename would otherwise run: the migration
      // must treat the absent table as nothing to rename rather than erroring.
      await getDb().execute("DROP TABLE built_sites");

      await renameEventsToListings();

      const tables = await tableNames();
      expect(tables.has("listings")).toBe(true);
      // applySchemaChanges recreates the dropped table with the current schema.
      expect(await columnNames("built_sites")).toContain("assigned_listing_id");
    });

    test("is a no-op when listing tables already exist (fresh database)", async () => {
      // A migrated database has no legacy event tables: every rename is
      // skipped and the already-current schema is left untouched.
      const before = await getAllListings();
      await renameEventsToListings();
      const after = await getAllListings();
      expect(after.length).toBe(before.length);

      const tables = await tableNames();
      expect(tables.has("events")).toBe(false);
      expect(tables.has("listings")).toBe(true);
    });
  });

  describe("renameEmailPrefsToContactPrefs (email_preferences → contact_preferences)", () => {
    const columnNames = async (table: string): Promise<string[]> => {
      const result = await getDb().execute(
        `SELECT name FROM pragma_table_info('${table}')`,
      );
      return result.rows.map((r) => String(r.name));
    };

    const tableNames = async (): Promise<Set<string>> => {
      const result = await getDb().execute(
        "SELECT name FROM sqlite_master WHERE type = 'table'",
      );
      return new Set(result.rows.map((r) => String(r.name)));
    };

    const indexNames = async (): Promise<Set<string>> => {
      const result = await getDb().execute(
        "SELECT name FROM sqlite_master WHERE type = 'index'",
      );
      return new Set(result.rows.map((r) => String(r.name)));
    };

    /**
     * Recreate the legacy email_preferences table shape (PK email_hash,
     * unsubscribed, stats_blob, created) by dropping the current table and
     * building the historical one, so the migration has a genuine legacy table
     * to upgrade rather than a fresh one.
     */
    const downgradeToLegacyTable = async (seed?: {
      emailHash: string;
      createdIso: string;
      unsubscribed: number;
    }): Promise<void> => {
      await getDb().execute("DROP TABLE IF EXISTS contact_preferences");
      await getDb().execute(
        "CREATE TABLE email_preferences (email_hash TEXT PRIMARY KEY, unsubscribed INTEGER NOT NULL DEFAULT 0, stats_blob TEXT NOT NULL DEFAULT '', created TEXT NOT NULL)",
      );
      if (seed) {
        await getDb().execute({
          args: [seed.emailHash, seed.unsubscribed, seed.createdIso],
          sql: "INSERT INTO email_preferences (email_hash, unsubscribed, created) VALUES (?, ?, ?)",
        });
      }
    };

    test("renames the table and PK column and adds the new columns", async () => {
      await downgradeToLegacyTable();

      await renameEmailPrefsToContactPrefs();

      const tables = await tableNames();
      expect(tables.has("contact_preferences")).toBe(true);
      expect(tables.has("email_preferences")).toBe(false);

      const cols = await columnNames("contact_preferences");
      expect(cols).toContain("contact_hash");
      expect(cols).toContain("last_activity");
      expect(cols).toContain("visits");
      expect(cols).not.toContain("email_hash");
      // The legacy created column is dropped once last_activity is backfilled.
      expect(cols).not.toContain("created");
    });

    test("backfills last_activity from the legacy created timestamp", async () => {
      const createdIso = "2025-01-02T03:04:05Z";
      const expectedMs = Date.parse(createdIso);
      await downgradeToLegacyTable({
        createdIso,
        emailHash: "legacy-hash",
        unsubscribed: 1,
      });

      await renameEmailPrefsToContactPrefs();

      const row = await getDb().execute({
        args: ["legacy-hash"],
        sql: "SELECT last_activity, unsubscribed FROM contact_preferences WHERE contact_hash = ?",
      });
      // last_activity is the created instant in ms (so the pre-existing
      // unsubscribe history isn't pruned immediately), and unsubscribe survives.
      expect(Number(row.rows[0]?.last_activity)).toBe(expectedMs);
      expect(Number(row.rows[0]?.unsubscribed)).toBe(1);
    });

    test("creates the contact-preferences indexes", async () => {
      await downgradeToLegacyTable();

      await renameEmailPrefsToContactPrefs();

      const indexes = await indexNames();
      expect(indexes.has("idx_contact_prefs_unsubscribed")).toBe(true);
      expect(indexes.has("idx_contact_prefs_last_activity")).toBe(true);
    });

    test("is a no-op on a fresh database that already has the final schema", async () => {
      // A migrated DB has no legacy email_preferences table: the rename is
      // skipped and the already-current contact_preferences is left intact.
      await renameEmailPrefsToContactPrefs();

      const tables = await tableNames();
      expect(tables.has("email_preferences")).toBe(false);
      expect(tables.has("contact_preferences")).toBe(true);
      const cols = await columnNames("contact_preferences");
      expect(cols).toContain("contact_hash");
      expect(cols).toContain("visits");
      expect(cols).not.toContain("created");
    });

    test("backfills last_activity even when the legacy table lacks the column entirely", async () => {
      // Guards the "ensure last_activity exists before backfill" path: a legacy
      // table missing the column must get it added and backfilled, not throw.
      const createdIso = "2024-06-01T00:00:00Z";
      await downgradeToLegacyTable({
        createdIso,
        emailHash: "no-col-hash",
        unsubscribed: 0,
      });
      // Confirm the precondition: no last_activity column on the legacy table.
      expect(await columnNames("email_preferences")).not.toContain(
        "last_activity",
      );

      await renameEmailPrefsToContactPrefs();

      const row = await getDb().execute({
        args: ["no-col-hash"],
        sql: "SELECT last_activity FROM contact_preferences WHERE contact_hash = ?",
      });
      expect(Number(row.rows[0]?.last_activity)).toBe(Date.parse(createdIso));
    });
  });

  describe("initDb ready cache", () => {
    test("initDb runs no queries once the client is confirmed ready", async () => {
      await initDb();

      const executeStub = stub(getDb(), "execute", () =>
        Promise.reject(new Error("query after database confirmed ready")),
      );
      try {
        await initDb();
        expect(executeStub.calls.length).toBe(0);
      } finally {
        executeStub.restore();
      }
    });

    test("initDb retries after a failed attempt instead of caching the failure", async () => {
      invalidateInitDbCache();
      const failingStub = stub(getDb(), "execute", () =>
        Promise.reject(new Error("transient outage")),
      );
      try {
        await expect(initDb()).rejects.toThrow("transient outage");
      } finally {
        failingStub.restore();
      }

      // Same client, no explicit invalidation: the failure must not have
      // been cached, so this call re-checks and succeeds.
      await initDb();

      const readyStub = stub(getDb(), "execute", () =>
        Promise.reject(new Error("query after database confirmed ready")),
      );
      try {
        await initDb();
        expect(readyStub.calls.length).toBe(0);
      } finally {
        readyStub.restore();
      }
    });

    test("resetDatabase clears the ready cache so initDb re-checks", async () => {
      await initDb();

      await resetDatabase();
      invalidateTestDbCache();

      await expect(initDb()).rejects.toBeInstanceOf(MissingSettingsTableError);
    });

    test("a different client is not treated as ready", async () => {
      await initDb();

      const client = createClient({ url: ":memory:" });
      setDb(client);
      try {
        await expect(initDb()).rejects.toBeInstanceOf(
          MissingSettingsTableError,
        );
      } finally {
        setDb(null);
      }
    });
  });

  describe("pre-migration backup", () => {
    test("skips backup when only restoring stale schema markers", async () => {
      const tmpDir = Deno.makeTempDirSync();
      const restore = setTestEnv({ LOCAL_STORAGE_PATH: tmpDir });
      try {
        await getDb().execute(
          "UPDATE settings SET value = 'stale' WHERE key = 'db_schema_hash'",
        );
        invalidateInitDbCache();
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

    test("creates backup before migrating existing database when storage is enabled", async () => {
      const tmpDir = Deno.makeTempDirSync();
      const restore = setTestEnv({ LOCAL_STORAGE_PATH: tmpDir });
      try {
        await getDb().execute(
          "UPDATE settings SET value = 'stale' WHERE key = 'db_schema_hash'",
        );
        await markCurrentSchemaMigrationPending();
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
        await markCurrentSchemaMigrationPending();
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
        await initDb({ allowMissingSettings: true });

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
        await markCurrentSchemaMigrationPending();
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
        await markCurrentSchemaMigrationPending();
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
        const lockResult = await getDb().execute(
          "SELECT value FROM settings WHERE key = 'migration_lock'",
        );
        expect(lockResult.rows.length).toBe(0);
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

describe("db > migrations > schema change guard", () => {
  // If this test fails, SCHEMA was changed. Existing production databases
  // are only upgraded through named migrations: add a new MIGRATIONS entry
  // for the change, then update BOTH snapshots below together. Deploying a
  // SCHEMA change without a new named migration makes initDb fail on every
  // request against existing databases ("markers are stale, no named
  // migrations are pending").
  test("SCHEMA_HASH changes only alongside a new named migration", () => {
    expect({ migrationIds: MIGRATION_IDS, schemaHash: SCHEMA_HASH }).toEqual({
      migrationIds: [
        "2026-06-11_current_schema",
        "2026-06-12_sumup_checkouts",
        "2026-06-13_event_attendees_overlap_index",
        "2026-06-14_rename_events_to_listings",
        "2026-06-14_question_sort_order",
        "2026-06-14_email_preferences",
        "2026-06-14_listing_customisable_days",
        "2026-06-14_attendee_statuses",
        "2026-06-15_activity_log_listing_id_index",
        "2026-06-16_logistics_agents",
        "2026-06-16_email_templates",
        "2026-06-16_agent_users",
        "2026-06-16_processed_payments_failure_data",
        "2026-06-16_listing_aggregates",
        "2026-06-16_modifiers",
        "2026-06-17_contact_preferences",
        "2026-06-17_modifier_min_visits",
      ],
      schemaHash: "1iw4a1g",
    });
  });
});
