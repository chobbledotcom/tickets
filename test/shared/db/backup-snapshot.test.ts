import {
  createClient,
  type InStatement,
  type Transaction,
  type TransactionMode,
} from "@libsql/client";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  backupDumpDatabaseCalls,
  countSchemaTableRows,
  createBackup,
  exportTable,
  snapshotReader,
} from "#db/backup-snapshot.ts";
import { getDb, setDb, withReadSnapshot } from "#db/client.ts";
import { initDb, SCHEMA_TABLE_NAMES } from "#db/migrations.ts";
import { getEnv } from "#shared/env.ts";
import { proxyMembers } from "#shared/proxy-members.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { withEnv } from "#test-utils/env.ts";

describeWithEnv("backup snapshot", { db: true }, () => {
  /** Export one table through its own snapshot, the way a dump does. */
  const exportFromSnapshot = async (
    table: string,
    pageSize?: number,
  ): Promise<{ sql: string; rowCount: number }> =>
    withReadSnapshot((snapshot) =>
      exportTable(table, snapshotReader(snapshot), pageSize),
    );

  describe("exportTable", () => {
    test("returns empty sql and zero rowCount for empty table", async () => {
      expect(await exportFromSnapshot("listings")).toEqual({
        rowCount: 0,
        sql: "",
      });
    });

    test("exports INSERT statements for table with data", async () => {
      await createTestListing({ name: "Test Listing" });
      const { sql, rowCount } = await exportFromSnapshot("listings");
      expect(sql).toContain('INSERT INTO "listings"');
      expect(rowCount).toBe(1);
    });

    test("quotes column names in INSERT statements", async () => {
      await createTestListing({ name: "Quote Test" });
      const { sql } = await exportFromSnapshot("listings");
      expect(sql).toMatch(/INSERT INTO "listings" \("id", "created"/);
    });

    test("batches multiple rows into a single multi-row INSERT", async () => {
      await createTestListing({ name: "Row One" });
      await createTestListing({ name: "Row Two" });
      const { sql, rowCount } = await exportFromSnapshot("listings");
      expect(rowCount).toBe(2);
      // One statement (one trailing semicolon), two value tuples.
      expect(sql.match(/;/g)).toHaveLength(1);
      expect(sql).toContain("), (");
    });

    test("handles NULL values", async () => {
      await createTestListing({ name: "Null Test" });
      const { sql } = await exportFromSnapshot("listings");
      expect(sql).toContain("NULL");
    });

    test("escapes single quotes by doubling them", async () => {
      // Seeded at the storage layer with bound args, so nothing escapes the
      // quote on the way in — only the dump's own escaping can double it.
      await getDb().execute({
        args: ["quote-test", "O'Brien's Gala"],
        sql: "INSERT INTO settings (key, value) VALUES (?, ?)",
      });
      const { sql } = await exportFromSnapshot("settings");
      expect(sql).toContain("'O''Brien''s Gala'");
    });

    test("keyset-paginates across multiple pages without losing rows", async () => {
      const pageOne = await createTestListing({ name: "Page One" });
      const pageTwo = await createTestListing({ name: "Page Two" });
      const pageThree = await createTestListing({ name: "Page Three" });

      // A page size of 2 forces two reads (2 rows, then 1) so the keyset loop
      // must continue past the first full page and stop on the short one.
      const { sql, rowCount } = await exportFromSnapshot("listings", 2);

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
      const { sql, rowCount } = await exportFromSnapshot("listings", 2);
      expect(rowCount).toBe(5);
      expect(sql).toContain(`(${ids[4]},`);
    });
  });

  describe("withReadSnapshot", () => {
    test("refuses a write smuggled into the snapshot", async () => {
      await expect(
        withReadSnapshot((snapshot) =>
          snapshot.execute("DELETE FROM listings"),
        ),
      ).rejects.toThrow("accept only SELECT statements");
    });

    test("refuses a write smuggled into a snapshot batch", async () => {
      await expect(
        withReadSnapshot((snapshot) =>
          snapshot.batch([
            { args: [], sql: "SELECT 1" },
            { args: [], sql: "UPDATE settings SET value = 'x'" },
          ]),
        ),
      ).rejects.toThrow("accept only SELECT statements");
    });

    test("closes the snapshot when the work throws", async () => {
      await expect(
        withReadSnapshot(() => Promise.reject(new Error("boom"))),
      ).rejects.toThrow("boom");
      // The next snapshot opens cleanly: the failed one released its stream.
      await expect(
        withReadSnapshot((snapshot) =>
          snapshot.batch([{ args: [], sql: "SELECT 1" }]),
        ),
      ).resolves.toHaveLength(1);
    });
  });
  describe("one snapshot per dump", () => {
    test("every page of a dump reads one database state", async () => {
      const before = await createTestListing({ name: "Before" });
      // WAL gives the reader/writer independence a remote libsql database has;
      // the suite's other clients carry a speed pragma that cannot hold a WAL
      // file, so the dump runs on a client opened after the switch.
      await getDb().execute("PRAGMA journal_mode=WAL");
      const dumpBase = createClient({ url: getEnv("DB_URL")! });
      setDb(dumpBase);
      const intruder = createClient({ url: getEnv("DB_URL")! });
      let snapshotBatches = 0;
      // The dump's snapshot writes one intruder listing through a second
      // connection as its first-page batch begins — after the table-list read
      // pinned the snapshot, before any later page — so the pages that follow
      // race a committed write. With one snapshot they must not see it.
      const injected = proxyMembers(dumpBase, {
        transaction: async (mode?: TransactionMode): Promise<Transaction> => {
          const tx = await dumpBase.transaction(mode);
          return proxyMembers(tx, {
            batch: async (statements: InStatement[]) => {
              if (snapshotBatches++ === 0) {
                await intruder.execute({
                  args: ["2026-01-01T00:00:00.000Z", 10, "Mid-dump intruder"],
                  sql: "INSERT INTO listings (created, max_attendees, name) VALUES (?, ?, ?)",
                });
              }
              return tx.batch(statements);
            },
          });
        },
      });
      setDb(injected);
      try {
        // A page size of 1 forces the listings table through a second page
        // read; the intruder write lands before it. Names are encrypted at
        // rest, so rows are told apart by id: Before is the rowid before the
        // intruder's.
        using _pageSize = withEnv({ BACKUP_PAGE_SIZE: "1" });
        const backups = await createBackup();

        const listings = backups.find((b) => b.table === "listings");
        expect(listings?.rowCount).toBe(1);
        expect(listings?.sql).toContain(`(${before.id},`);
        expect(snapshotBatches).toBeGreaterThan(0);
        // The intruder's row carries the next rowid; it is in no table's dump:
        // every page read the same pre-write state.
        for (const backup of backups) {
          expect(backup.sql).not.toContain(`(${before.id + 1},`);
        }
      } finally {
        setDb(null);
        await intruder.close();
        await dumpBase.close();
      }
    });
  });

  describe("backupDumpDatabaseCalls", () => {
    test("charges three calls for an empty database", () => {
      expect(backupDumpDatabaseCalls([], 500)).toBe(3);
    });

    test("tables that fit their first page ride the shared batch", () => {
      expect(backupDumpDatabaseCalls([499, 1, 250], 500)).toBe(3);
    });

    test("each full page costs one extra read", () => {
      const cases: [rows: number, pageSize: number, calls: number][] = [
        [500, 500, 4],
        [501, 500, 4],
        [999, 500, 4],
        [1000, 500, 5],
        [3, 1, 6],
      ];
      for (const [rows, pageSize, calls] of cases) {
        expect(backupDumpDatabaseCalls([rows], pageSize)).toBe(calls);
      }
    });

    test("sums extra pages across tables", () => {
      expect(backupDumpDatabaseCalls([500, 1000, 499], 500)).toBe(6);
    });

    test("reads the page size from BACKUP_PAGE_SIZE by default", () => {
      using _env = withEnv({ BACKUP_PAGE_SIZE: "1" });
      // Three one-row pages past the shared first-page batch: 3 + 3.
      expect(backupDumpDatabaseCalls([3])).toBe(6);
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
