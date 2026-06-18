import {
  type Client,
  createClient,
  type ResultSet,
  type TransactionMode,
} from "@libsql/client";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { getDb, setDb } from "#shared/db/client.ts";
import { getAllListings } from "#shared/db/listings.ts";
import {
  initDb,
  invalidateInitDbCache,
  LATEST_UPDATE,
  MIGRATION_IDS,
  MissingSettingsTableError,
  resetDatabase,
  SCHEMA_HASH,
} from "#shared/db/migrations.ts";
import {
  describeWithEnv,
  invalidateTestDbCache,
  setTestEnv,
} from "#test-utils";
import { markCurrentSchemaMigrationPending } from "./migration-test-helpers.ts";

describeWithEnv("db > migrations", { db: true }, () => {
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
});
