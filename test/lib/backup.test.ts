import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { unzipSync, zipSync } from "fflate";
import {
  type BackupManifest,
  backupFilename,
  backupTimestamp,
  countZipStatements,
  createBackup,
  createBackupZip,
  dbName,
  exportTable,
  isRemoteDatabase,
  readManifest,
  restoreFromSql,
  restoreFromZip,
  splitStatements,
} from "#shared/db/backup.ts";
import { getDb, queryAll } from "#shared/db/client.ts";
import { eventsTable } from "#shared/db/events.ts";
import {
  initDb,
  SCHEMA_HASH,
  SCHEMA_TABLE_NAMES,
} from "#shared/db/migrations.ts";
import { createTestEvent, describeWithEnv, setTestEnv } from "#test-utils";

describeWithEnv("backup", { db: true }, () => {
  describe("splitStatements", () => {
    test("splits on semicolon-newline boundaries", () => {
      const stmts = splitStatements(
        "INSERT INTO a VALUES (1);\nINSERT INTO b VALUES (2);",
      );
      expect(stmts).toHaveLength(2);
      expect(stmts[0]).toBe("INSERT INTO a VALUES (1);");
      expect(stmts[1]).toBe("INSERT INTO b VALUES (2);");
    });

    test("returns empty array for empty input", () => {
      expect(splitStatements("")).toHaveLength(0);
      expect(splitStatements("   ")).toHaveLength(0);
    });

    test("handles trailing newline", () => {
      const stmts = splitStatements("INSERT INTO a VALUES (1);\n");
      expect(stmts).toHaveLength(1);
    });
  });

  describe("exportTable", () => {
    test("returns empty string for empty table", async () => {
      expect(await exportTable("events")).toBe("");
    });

    test("exports INSERT statements for table with data", async () => {
      await createTestEvent({ name: "Test Event" });
      const sql = await exportTable("events");
      expect(sql).toContain('INSERT INTO "events"');
    });

    test("quotes column names in INSERT statements", async () => {
      await createTestEvent({ name: "Quote Test" });
      const sql = await exportTable("events");
      expect(sql).toMatch(/INSERT INTO "events" \("id", "created"/);
    });

    test("handles NULL values", async () => {
      await createTestEvent({ name: "Null Test" });
      const sql = await exportTable("events");
      expect(sql).toContain("NULL");
    });
  });

  describe("createBackup", () => {
    test("returns tables in SCHEMA order", async () => {
      const backups = await createBackup();
      expect(backups.map((b) => b.table)).toEqual(SCHEMA_TABLE_NAMES);
    });

    test("skips tables that do not exist", async () => {
      await getDb().execute("DROP TABLE IF EXISTS holidays");
      try {
        const backups = await createBackup();
        const names = backups.map((b) => b.table);
        expect(names).not.toContain("holidays");
        expect(names.length).toBe(SCHEMA_TABLE_NAMES.length - 1);
      } finally {
        await initDb();
      }
    });
  });

  describe("createBackupZip", () => {
    test("creates zip with .sql files and manifest", async () => {
      await createTestEvent({ name: "Zip Test" });
      const zipData = await createBackupZip();
      const files = unzipSync(zipData);

      // All tables present
      for (const table of SCHEMA_TABLE_NAMES) {
        expect(Object.keys(files)).toContain(`${table}.sql`);
      }

      // Manifest has correct schema hash
      const manifest: BackupManifest = JSON.parse(
        new TextDecoder().decode(files["manifest.json"]!),
      );
      expect(manifest.schemaHash).toBe(SCHEMA_HASH);
      expect(manifest.latestUpdate).toBeTruthy();
      expect(manifest.timestamp).toBeTruthy();
      expect(manifest.tables.events).toBe(1);
    });
  });

  describe("readManifest", () => {
    test("reads manifest from backup zip", async () => {
      const manifest = readManifest(await createBackupZip());
      expect(manifest).not.toBeNull();
      expect(manifest!.schemaHash).toBe(SCHEMA_HASH);
    });

    test("returns null for zip without manifest", () => {
      expect(readManifest(zipSync({ "a.sql": new Uint8Array(0) }))).toBeNull();
    });

    test("returns null for manifest with invalid shape", () => {
      const encoder = new TextEncoder();
      const zip = zipSync({
        "manifest.json": encoder.encode(JSON.stringify({ wrong: "shape" })),
      });
      expect(readManifest(zip)).toBeNull();
    });

    test("returns null for manifest missing required fields", () => {
      const encoder = new TextEncoder();
      const zip = zipSync({
        "manifest.json": encoder.encode(
          JSON.stringify({ latestUpdate: "ok", schemaHash: "ok" }),
        ),
      });
      expect(readManifest(zip)).toBeNull();
    });
  });

  describe("dbName", () => {
    test("returns 'local' for in-memory databases", () => {
      expect(dbName()).toBe("local");
    });

    test("extracts name from libsql:// URL", () => {
      const restore = setTestEnv({
        DB_URL:
          "libsql://01KFXBFGMADR58XZ2PBX7HCB5Y-tickets-spencer.lite.bunnydb.net/",
      });
      try {
        expect(dbName()).toBe("tickets-spencer");
      } finally {
        restore();
      }
    });

    test("extracts name from https:// URL", () => {
      const restore = setTestEnv({
        DB_URL: "https://abc123-my-site.turso.io",
      });
      try {
        expect(dbName()).toBe("my-site");
      } finally {
        restore();
      }
    });

    test("returns full hostname segment when no dash", () => {
      const restore = setTestEnv({ DB_URL: "libsql://standalone.turso.io" });
      try {
        expect(dbName()).toBe("standalone");
      } finally {
        restore();
      }
    });

    test("returns 'local' for invalid URLs", () => {
      const restore = setTestEnv({ DB_URL: "not-a-url" });
      try {
        expect(dbName()).toBe("local");
      } finally {
        restore();
      }
    });
  });

  describe("backupFilename / backupTimestamp", () => {
    test("creates filename with db name and .zip extension", () => {
      // In test env, DB_URL is :memory: so dbName() returns "local"
      expect(backupFilename("2024-01-15T12-30-00-000Z")).toBe(
        "backup-local-2024-01-15T12-30-00-000Z.zip",
      );
    });

    test("returns ISO-like timestamp with dashes", () => {
      expect(backupTimestamp()).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/,
      );
    });
  });

  describe("countZipStatements", () => {
    test("counts SQL statements across files in zip", async () => {
      await createTestEvent({ name: "Count Test" });
      const count = countZipStatements(await createBackupZip());
      expect(count).toBeGreaterThanOrEqual(2);
    });
  });

  describe("restoreFromSql", () => {
    test("restores data from SQL statements", async () => {
      await createTestEvent({ name: "Before Restore" });
      const backup = await exportTable("events");
      await restoreFromSql(backup);
      const events = await queryAll<Record<string, unknown>>(
        "SELECT * FROM events",
      );
      expect(events.length).toBe(1);
    });

    test("clears existing data before restoring", async () => {
      await createTestEvent({ name: "Gone" });
      await restoreFromSql("");
      const events = await queryAll<Record<string, unknown>>(
        "SELECT * FROM events",
      );
      expect(events.length).toBe(0);
    });
  });

  describe("restoreFromZip", () => {
    test("round-trips backup and restore", async () => {
      await createTestEvent({ name: "Zip Restore Test" });
      await restoreFromZip(await createBackupZip());
      const events = await eventsTable.findAll();
      expect(events.length).toBe(1);
      expect(events[0]!.name).toBe("Zip Restore Test");
    });

    test("preserves newlines in values through roundtrip", async () => {
      await createTestEvent({
        description: "first\nsecond\nthird",
        name: "Newline Zip",
      });
      await restoreFromZip(await createBackupZip());
      const events = await eventsTable.findAll();
      expect(events[0]!.description.replace(/\r\n/g, "\n")).toBe(
        "first\nsecond\nthird",
      );
    });

    test("handles zip with missing table files", async () => {
      const partial = zipSync({
        "settings.sql": new TextEncoder().encode(
          "INSERT INTO settings (key, value) VALUES ('k', 'v');",
        ),
      });
      await restoreFromZip(partial);
      const rows = await queryAll<{ value: string }>(
        "SELECT value FROM settings WHERE key = 'k'",
      );
      expect(rows[0]!.value).toBe("v");
    });
  });

  describe("isRemoteDatabase", () => {
    test("returns false for local URLs", () => {
      expect(isRemoteDatabase()).toBe(false);
    });

    test("returns true for libsql:// URLs", () => {
      const restore = setTestEnv({ DB_URL: "libsql://db.turso.io" });
      try {
        expect(isRemoteDatabase()).toBe(true);
      } finally {
        restore();
      }
    });

    test("returns true for https:// URLs", () => {
      const restore = setTestEnv({ DB_URL: "https://db.turso.io" });
      try {
        expect(isRemoteDatabase()).toBe(true);
      } finally {
        restore();
      }
    });
  });
});
