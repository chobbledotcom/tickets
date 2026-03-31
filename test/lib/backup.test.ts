import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { unzipSync, zipSync } from "fflate";
import {
  backupFilename,
  type BackupManifest,
  backupTimestamp,
  countZipStatements,
  createBackup,
  createBackupZip,
  exportTable,
  isRemoteDatabase,
  readManifest,
  restoreFromSql,
  restoreFromZip,
  splitStatements,
} from "#lib/db/backup.ts";
import { queryAll } from "#lib/db/client.ts";
import { SCHEMA_HASH, SCHEMA_TABLE_NAMES } from "#lib/db/migrations.ts";
import { createTestEvent, describeWithEnv } from "#test-utils";

describeWithEnv("backup", { db: true }, () => {
  describe("splitStatements", () => {
    test("splits on semicolon-newline boundaries", () => {
      const sql = "INSERT INTO a VALUES (1);\nINSERT INTO b VALUES (2);";
      const stmts = splitStatements(sql);
      expect(stmts).toHaveLength(2);
      expect(stmts[0]).toBe("INSERT INTO a VALUES (1);");
      expect(stmts[1]).toBe("INSERT INTO b VALUES (2);");
    });

    test("handles values with embedded newlines", () => {
      const sql =
        "INSERT INTO a (t) VALUES ('line1\nline2');\nINSERT INTO b VALUES (1);";
      const stmts = splitStatements(sql);
      expect(stmts).toHaveLength(2);
      expect(stmts[0]).toContain("line1\nline2");
    });

    test("skips empty lines and comments", () => {
      const sql =
        "-- comment\n\nINSERT INTO a VALUES (1);\n\n-- another\nINSERT INTO b VALUES (2);";
      const stmts = splitStatements(sql);
      expect(stmts).toHaveLength(2);
    });

    test("handles trailing statement without newline", () => {
      const sql = "INSERT INTO a VALUES (1);";
      const stmts = splitStatements(sql);
      expect(stmts).toHaveLength(1);
    });

    test("returns empty array for empty input", () => {
      expect(splitStatements("")).toHaveLength(0);
      expect(splitStatements("-- only comments")).toHaveLength(0);
    });
  });

  describe("exportTable", () => {
    test("returns empty string for empty table", async () => {
      const sql = await exportTable("events");
      expect(sql).toBe("");
    });

    test("exports INSERT statements for table with data", async () => {
      await createTestEvent({ name: "Test Event", description: "A test" });
      const sql = await exportTable("events");
      expect(sql).toContain("INSERT INTO events");
      expect(sql).toContain("Test Event");
    });

    test("escapes single quotes in values", async () => {
      await createTestEvent({
        name: "Event's Name",
        description: "It's a test",
      });
      const sql = await exportTable("events");
      expect(sql).toContain("Event''s Name");
    });

    test("handles NULL values", async () => {
      await createTestEvent({ name: "Null Test" });
      const sql = await exportTable("events");
      expect(sql).toContain("NULL");
    });

    test("produces deterministic output with ORDER BY rowid", async () => {
      await createTestEvent({ name: "Second" });
      await createTestEvent({ name: "First" });
      const sql = await exportTable("events");
      const secondIdx = sql.indexOf("Second");
      const firstIdx = sql.indexOf("First");
      // "Second" was inserted first (rowid 1), so it should appear before "First" (rowid 2)
      expect(secondIdx).toBeLessThan(firstIdx);
    });
  });

  describe("createBackup", () => {
    test("returns tables in SCHEMA order", async () => {
      const backups = await createBackup();
      const names = backups.map((b) => b.table);
      expect(names).toEqual(SCHEMA_TABLE_NAMES);
    });

    test("each backup has table name and sql string", async () => {
      const backups = await createBackup();
      for (const backup of backups) {
        expect(typeof backup.table).toBe("string");
        expect(typeof backup.sql).toBe("string");
      }
    });
  });

  describe("createBackupZip", () => {
    test("creates a valid zip with one .sql file per table", async () => {
      await createTestEvent({ name: "Zip Test" });
      const zipData = await createBackupZip();
      const files = unzipSync(zipData);
      expect(Object.keys(files)).toContain("events.sql");
      expect(Object.keys(files)).toContain("settings.sql");
      const decoder = new TextDecoder();
      expect(decoder.decode(files["events.sql"]!)).toContain("Zip Test");
    });

    test("includes all tables in zip", async () => {
      const zipData = await createBackupZip();
      const files = unzipSync(zipData);
      for (const table of SCHEMA_TABLE_NAMES) {
        expect(Object.keys(files)).toContain(`${table}.sql`);
      }
    });

    test("includes manifest.json with schema metadata", async () => {
      await createTestEvent({ name: "Manifest Test" });
      const zipData = await createBackupZip();
      const files = unzipSync(zipData);
      expect(Object.keys(files)).toContain("manifest.json");
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
      const zipData = await createBackupZip();
      const manifest = readManifest(zipData);
      expect(manifest).not.toBeNull();
      expect(manifest!.schemaHash).toBe(SCHEMA_HASH);
    });

    test("returns null for zip without manifest", () => {
      const zipData = zipSync({ "test.sql": new Uint8Array(0) });
      expect(readManifest(zipData)).toBeNull();
    });
  });

  describe("backupFilename", () => {
    test("creates filename with timestamp and .zip extension", () => {
      const name = backupFilename("2024-01-15T12-30-00-000Z");
      expect(name).toBe("backup-2024-01-15T12-30-00-000Z.zip");
    });
  });

  describe("backupTimestamp", () => {
    test("returns ISO-like timestamp with dashes", () => {
      const ts = backupTimestamp();
      expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/);
    });
  });

  describe("countZipStatements", () => {
    test("counts SQL statements across all files in zip", async () => {
      await createTestEvent({ name: "Count Test" });
      const zipData = await createBackupZip();
      const count = countZipStatements(zipData);
      // At least the settings rows + the event we inserted
      expect(count).toBeGreaterThanOrEqual(2);
    });

    test("skips manifest.json when counting", async () => {
      const zipData = await createBackupZip();
      const count = countZipStatements(zipData);
      const files = unzipSync(zipData);
      const decoder = new TextDecoder();
      let expectedCount = 0;
      for (const [name, data] of Object.entries(files)) {
        if (!name.endsWith(".sql")) continue;
        const content = decoder.decode(data!);
        if (content.trim()) expectedCount += splitStatements(content).length;
      }
      expect(count).toBe(expectedCount);
    });
  });

  describe("restoreFromSql", () => {
    test("restores data from SQL statements", async () => {
      await createTestEvent({ name: "Before Restore", description: "gone" });

      const backup = await exportTable("events");
      await restoreFromSql(backup);

      const events = await queryAll<{ name: string }>(
        "SELECT name FROM events",
      );
      expect(events.length).toBe(1);
      expect(events[0]!.name).toBe("Before Restore");
    });

    test("handles values with embedded newlines", async () => {
      await createTestEvent({
        name: "Newline Test",
        description: "line1\nline2\nline3",
      });

      const backup = await exportTable("events");
      await restoreFromSql(backup);

      const events = await queryAll<{ description: string }>(
        "SELECT description FROM events",
      );
      expect(events[0]!.description).toBe("line1\nline2\nline3");
    });

    test("clears existing data before restoring", async () => {
      await createTestEvent({ name: "Existing Event" });

      await restoreFromSql("");
      const events = await queryAll<{ name: string }>(
        "SELECT name FROM events",
      );
      expect(events.length).toBe(0);
    });
  });

  describe("restoreFromZip", () => {
    test("round-trips backup and restore via zip", async () => {
      await createTestEvent({ name: "Zip Restore Test" });

      const zipData = await createBackupZip();
      await restoreFromZip(zipData);

      const events = await queryAll<{ name: string }>(
        "SELECT name FROM events",
      );
      expect(events.length).toBe(1);
      expect(events[0]!.name).toBe("Zip Restore Test");
    });

    test("preserves newlines in values through zip roundtrip", async () => {
      await createTestEvent({
        name: "Newline Zip",
        description: "first\nsecond\nthird",
      });

      const zipData = await createBackupZip();
      await restoreFromZip(zipData);

      const events = await queryAll<{ description: string }>(
        "SELECT description FROM events",
      );
      expect(events[0]!.description).toBe("first\nsecond\nthird");
    });
  });

  describe("isRemoteDatabase", () => {
    test("returns false for file: or :memory: URLs", () => {
      expect(isRemoteDatabase()).toBe(false);
    });
  });
});
