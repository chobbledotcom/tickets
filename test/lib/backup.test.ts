import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  backupFilename,
  backupTimestamp,
  createBackup,
  exportTable,
  isRemoteDatabase,
  listTables,
  restoreFromSql,
} from "#lib/db/backup.ts";
import { queryAll, queryOne } from "#lib/db/client.ts";
import { eventsTable } from "#lib/db/events.ts";
import { describeWithEnv } from "#test-utils";

describeWithEnv("backup", { db: true }, () => {
  describe("listTables", () => {
    test("returns all application tables", async () => {
      const tables = await listTables();
      expect(tables).toContain("settings");
      expect(tables).toContain("events");
      expect(tables).toContain("users");
      expect(tables).toContain("attendees");
      expect(tables.length).toBeGreaterThanOrEqual(10);
    });

    test("excludes sqlite internal tables", async () => {
      const tables = await listTables();
      for (const table of tables) {
        expect(table).not.toMatch(/^sqlite_/);
      }
    });
  });

  describe("exportTable", () => {
    test("returns empty string for empty table", async () => {
      const sql = await exportTable("events");
      expect(sql).toBe("");
    });

    test("exports INSERT statements for table with data", async () => {
      await eventsTable.insert({
        name: "Test Event",
        description: "A test",
        maxAttendees: 100,
      });
      const sql = await exportTable("events");
      expect(sql).toContain("INSERT INTO events");
      expect(sql).toContain("Test Event");
    });

    test("escapes single quotes in values", async () => {
      await eventsTable.insert({
        name: "Event's Name",
        description: "It's a test",
        maxAttendees: 50,
      });
      const sql = await exportTable("events");
      expect(sql).toContain("Event''s Name");
    });

    test("handles NULL values", async () => {
      await eventsTable.insert({
        name: "Null Test",
        description: "",
        maxAttendees: 10,
      });
      const sql = await exportTable("events");
      expect(sql).toContain("NULL");
    });
  });

  describe("createBackup", () => {
    test("returns a TableBackup for each table", async () => {
      const backups = await createBackup();
      const tables = await listTables();
      expect(backups.length).toBe(tables.length);
      for (const backup of backups) {
        expect(tables).toContain(backup.table);
      }
    });

    test("each backup has table name and sql string", async () => {
      const backups = await createBackup();
      for (const backup of backups) {
        expect(typeof backup.table).toBe("string");
        expect(typeof backup.sql).toBe("string");
      }
    });
  });

  describe("backupFilename", () => {
    test("creates filename with timestamp and table name", () => {
      const name = backupFilename("events", "2024-01-15T12-30-00-000Z");
      expect(name).toBe("backup-2024-01-15T12-30-00-000Z-events.sql");
    });
  });

  describe("backupTimestamp", () => {
    test("returns ISO-like timestamp with dashes", () => {
      const ts = backupTimestamp();
      expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/);
    });
  });

  describe("restoreFromSql", () => {
    test("restores data from SQL statements", async () => {
      await eventsTable.insert({
        name: "Before Restore",
        description: "Will be gone",
        maxAttendees: 10,
      });

      const backup = await exportTable("events");

      // Clear and restore
      await restoreFromSql(backup);

      const events = await queryAll<{ name: string }>(
        "SELECT name FROM events",
      );
      expect(events.length).toBe(1);
      expect(events[0]!.name).toBe("Before Restore");
    });

    test("skips empty lines and comments", async () => {
      const sql = [
        "-- This is a comment",
        "",
        "INSERT INTO settings (key, value) VALUES ('test_key', 'test_value');",
        "",
        "-- Another comment",
      ].join("\n");

      await restoreFromSql(sql);
      const row = await queryOne<{ value: string }>(
        "SELECT value FROM settings WHERE key = ?",
        ["test_key"],
      );
      expect(row?.value).toBe("test_value");
    });

    test("clears existing data before restoring", async () => {
      await eventsTable.insert({
        name: "Existing Event",
        description: "",
        maxAttendees: 5,
      });

      await restoreFromSql("");
      const events = await queryAll<{ name: string }>(
        "SELECT name FROM events",
      );
      expect(events.length).toBe(0);
    });
  });

  describe("isRemoteDatabase", () => {
    test("returns false for file: or :memory: URLs", () => {
      // Test DB uses file: or :memory: URL, not libsql://
      expect(isRemoteDatabase()).toBe(false);
    });
  });
});
