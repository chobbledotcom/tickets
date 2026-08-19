import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  backupDumpDatabaseCalls,
  countSchemaTableRows,
  createBackup,
  exportTable,
} from "#db/backup-snapshot.ts";
import { getDb } from "#db/client.ts";
import { initDb, SCHEMA_TABLE_NAMES } from "#db/migrations.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { withEnv } from "#test-utils/env.ts";

describeWithEnv("backup snapshot", { db: true }, () => {
  describe("exportTable", () => {
    test("returns empty sql and zero rowCount for empty table", async () => {
      expect(await exportTable("listings")).toEqual({ rowCount: 0, sql: "" });
    });

    test("exports INSERT statements for table with data", async () => {
      await createTestListing({ name: "Test Listing" });
      const { sql, rowCount } = await exportTable("listings");
      expect(sql).toContain('INSERT INTO "listings"');
      expect(rowCount).toBe(1);
    });

    test("quotes column names in INSERT statements", async () => {
      await createTestListing({ name: "Quote Test" });
      const { sql } = await exportTable("listings");
      expect(sql).toMatch(/INSERT INTO "listings" \("id", "created"/);
    });

    test("batches multiple rows into a single multi-row INSERT", async () => {
      await createTestListing({ name: "Row One" });
      await createTestListing({ name: "Row Two" });
      const { sql, rowCount } = await exportTable("listings");
      expect(rowCount).toBe(2);
      // One statement (one trailing semicolon), two value tuples.
      expect(sql.match(/;/g)).toHaveLength(1);
      expect(sql).toContain("), (");
    });

    test("handles NULL values", async () => {
      await createTestListing({ name: "Null Test" });
      const { sql } = await exportTable("listings");
      expect(sql).toContain("NULL");
    });

    test("escapes single quotes by doubling them", async () => {
      // Seeded at the storage layer with bound args, so nothing escapes the
      // quote on the way in — only the dump's own escaping can double it.
      await getDb().execute({
        args: ["quote-test", "O'Brien's Gala"],
        sql: "INSERT INTO settings (key, value) VALUES (?, ?)",
      });
      const { sql } = await exportTable("settings");
      expect(sql).toContain("'O''Brien''s Gala'");
    });

    test("keyset-paginates across multiple pages without losing rows", async () => {
      const pageOne = await createTestListing({ name: "Page One" });
      const pageTwo = await createTestListing({ name: "Page Two" });
      const pageThree = await createTestListing({ name: "Page Three" });

      // A page size of 2 forces two reads (2 rows, then 1) so the keyset loop
      // must continue past the first full page and stop on the short one.
      const { sql, rowCount } = await exportTable("listings", 2);

      expect(rowCount).toBe(3);
      // One INSERT statement per page, and the cursor alias never leaks into the
      // dumped column list.
      expect(sql.match(/INSERT INTO "listings"/g)).toHaveLength(2);
      expect(sql).not.toContain("__backup_rowid__");
      expect(sql.match(new RegExp(`\\(${pageOne.id},`, "g"))).toHaveLength(1);
      expect(sql.match(new RegExp(`\\(${pageTwo.id},`, "g"))).toHaveLength(1);
      expect(sql.match(new RegExp(`\\(${pageThree.id},`, "g"))).toHaveLength(1);
      // Statements are newline-separated so a dump stays readable.
      expect(sql).toContain(';\nINSERT INTO "listings"');
    });

    test("the keyset cursor tracks the last row id, not a running sum", async () => {
      // Three pages: a summed cursor would agree on page two (0 + last id)
      // and only overshoot from page three on, silently dropping rows.
      const ids: number[] = [];
      for (let n = 1; n <= 5; n++) {
        ids.push((await createTestListing({ name: `Cursor ${n}` })).id);
      }
      const { sql, rowCount } = await exportTable("listings", 2);
      expect(rowCount).toBe(5);
      expect(sql).toContain(`(${ids[4]},`);
    });
  });

  describe("backupDumpDatabaseCalls", () => {
    test("charges two calls for an empty database", () => {
      expect(backupDumpDatabaseCalls([], 500)).toBe(2);
    });

    test("tables that fit their first page ride the shared batch", () => {
      expect(backupDumpDatabaseCalls([499, 1, 250], 500)).toBe(2);
    });

    test("each full page costs one extra read", () => {
      const cases: [rows: number, pageSize: number, calls: number][] = [
        [500, 500, 3],
        [501, 500, 3],
        [999, 500, 3],
        [1000, 500, 4],
        [3, 1, 5],
      ];
      for (const [rows, pageSize, calls] of cases) {
        expect(backupDumpDatabaseCalls([rows], pageSize)).toBe(calls);
      }
    });

    test("sums extra pages across tables", () => {
      expect(backupDumpDatabaseCalls([500, 1000, 499], 500)).toBe(5);
    });

    test("reads the page size from BACKUP_PAGE_SIZE by default", () => {
      using _env = withEnv({ BACKUP_PAGE_SIZE: "1" });
      // Three one-row pages past the shared first-page batch: 2 + 3.
      expect(backupDumpDatabaseCalls([3])).toBe(5);
    });
  });

  describe("countSchemaTableRows", () => {
    test("counts every schema table in order", async () => {
      await createTestListing({ name: "Counted" });
      const counts = await countSchemaTableRows();
      expect(counts).toHaveLength(SCHEMA_TABLE_NAMES.length);
      expect(counts[SCHEMA_TABLE_NAMES.indexOf("listings")]).toBe(1);
      expect(counts[SCHEMA_TABLE_NAMES.indexOf("attendees")]).toBe(0);
    });
  });

  describe("createBackup", () => {
    test("returns tables in SCHEMA order", async () => {
      const backups = await createBackup();
      expect(backups.map((b) => b.table)).toEqual(SCHEMA_TABLE_NAMES);
    });

    test("includes each table's first row", async () => {
      // The batched first pages start their keyset cursor below every real
      // rowid; a cursor of 1 would silently drop each table's first row.
      const listing = await createTestListing({ name: "First Row" });
      const backups = await createBackup();
      const listings = backups.find((backup) => backup.table === "listings");
      expect(listings?.rowCount).toBe(1);
      expect(listings?.sql).toContain(`(${listing.id},`);
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
});
