import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { createBackup, exportTable } from "#shared/db/backup-snapshot.ts";
import { getDb } from "#shared/db/client.ts";
import { initDb, SCHEMA_TABLE_NAMES } from "#shared/db/migrations.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";

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
});
