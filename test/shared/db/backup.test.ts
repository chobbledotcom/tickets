import type { ResultSet } from "@libsql/client";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { unzipSync, zipSync } from "fflate";
import {
  type BackupManifest,
  countZipStatements,
  createBackup,
  createBackupZip,
  exportTable,
  readManifest,
  restoreFromSql,
  restoreFromZip,
  splitStatements,
} from "#shared/db/backup.ts";
import { getDb, queryAll } from "#shared/db/client.ts";
import { listingsTable } from "#shared/db/listings/records.ts";
import { SCHEMA } from "#shared/db/migrations/schema/index.ts";
import { TRIGGERS } from "#shared/db/migrations/schema/triggers.ts";
import {
  initDb,
  LATEST_UPDATE,
  SCHEMA_HASH,
  SCHEMA_TABLE_NAMES,
} from "#shared/db/migrations.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";

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
      await createTestListing({ name: "Page One" });
      await createTestListing({ name: "Page Two" });
      await createTestListing({ name: "Page Three" });

      // A page size of 2 forces two reads (2 rows, then 1) so the keyset loop
      // must continue past the first full page and stop on the short one.
      const { sql, rowCount } = await exportTable("listings", 2);

      expect(rowCount).toBe(3);
      // One INSERT statement per page, and the cursor alias never leaks into the
      // dumped column list.
      expect(sql.match(/INSERT INTO "listings"/g)).toHaveLength(2);
      expect(sql).not.toContain("__backup_rowid__");
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
      await createTestListing({ name: "Zip Test" });
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
      expect(manifest.latestUpdate).toBe(LATEST_UPDATE);
      // A real instant, ISO-8601 formatted — not just any non-empty string.
      expect(new Date(manifest.timestamp).toISOString()).toBe(
        manifest.timestamp,
      );
      expect(manifest.tables.listings).toBe(1);
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

  describe("countZipStatements", () => {
    test("counts SQL statements across files in zip", async () => {
      await createTestListing({ name: "Count Test" });
      const count = countZipStatements(await createBackupZip());
      expect(count).toBeGreaterThanOrEqual(2);
    });
  });

  describe("restoreFromSql", () => {
    test("restores data from SQL statements", async () => {
      await createTestListing({ name: "Before Restore" });
      const { sql } = await exportTable("listings");
      await restoreFromSql(sql);
      const listings = await queryAll<Record<string, unknown>>(
        "SELECT * FROM listings",
      );
      expect(listings.length).toBe(1);
    });

    test("clears existing data before restoring", async () => {
      await createTestListing({ name: "Gone" });
      await restoreFromSql("");
      const listings = await queryAll<Record<string, unknown>>(
        "SELECT * FROM listings",
      );
      expect(listings.length).toBe(0);
    });

    test("initDb re-checks markers after a restore instead of trusting the ready cache", async () => {
      await initDb(); // the client is confirmed ready and cached

      // Restore a backup whose markers predate the current schema.
      await restoreFromSql(
        "INSERT INTO settings (key, value) VALUES ('latest_db_update', 'from-old-backup');\n" +
          "INSERT INTO settings (key, value) VALUES ('db_schema_hash', 'from-old-backup');\n",
      );

      await initDb();

      const result = await getDb().execute(
        "SELECT value FROM settings WHERE key = 'db_schema_hash'",
      );
      expect(result.rows[0]?.value).toBe(SCHEMA_HASH);
    });
  });

  describe("restoreFromZip", () => {
    test("round-trips backup and restore", async () => {
      await createTestListing({ name: "Zip Restore Test" });
      await restoreFromZip(await createBackupZip());
      const listings = await listingsTable.findAll();
      expect(listings.length).toBe(1);
      expect(listings[0]!.name).toBe("Zip Restore Test");
    });

    test("preserves newlines in values through roundtrip", async () => {
      await createTestListing({
        description: "first\nsecond\nthird",
        name: "Newline Zip",
      });
      await restoreFromZip(await createBackupZip());
      const listings = await listingsTable.findAll();
      expect(listings[0]!.description.replace(/\r\n/g, "\n")).toBe(
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

    const sqlOf = (stmt: string | { sql: string }): string =>
      typeof stmt === "string" ? stmt : stmt.sql;

    test("succeeds even when a stale read says the wiped database is up to date", async () => {
      // After the restore wipes every table, a lagging read replica can still
      // serve the old settings rows. The restore must never consult that state:
      // when it did (via initDb's state check), the stale "up to date" answer
      // routed it into schema verification against the wiped primary, and the
      // whole restore died with "missing table settings" — leaving the
      // operator's database empty.
      await createTestListing({ name: "Stale Read Survivor" });
      const zip = await createBackupZip();

      const client = getDb();
      const originalExecute = client.execute.bind(client);
      // The exact read initDb's state check issues; nothing else matches it.
      const isMarkerRead = (sql: string): boolean =>
        sql.includes("IN ('latest_db_update', 'db_schema_hash')");
      const staleMarkers = {
        rows: [
          { key: "latest_db_update", value: LATEST_UPDATE },
          { key: "db_schema_hash", value: SCHEMA_HASH },
        ],
      } as unknown as ResultSet;
      const executeStub = stub(client, "execute", ((
        stmt: string | { sql: string },
      ) =>
        isMarkerRead(sqlOf(stmt))
          ? Promise.resolve(staleMarkers)
          : originalExecute(stmt as never)) as never);

      try {
        await restoreFromZip(zip);
      } finally {
        executeStub.restore();
      }

      const listings = await listingsTable.findAll();
      expect(listings.length).toBe(1);
      expect(listings[0]!.name).toBe("Stale Read Survivor");
    });

    test("succeeds even when a schema snapshot still shows the pre-wipe tables", async () => {
      // resetDatabase()'s drops can also outrun the live-schema snapshot the
      // rebuild takes — even on the primary (read-your-writes propagation lag,
      // the effect VERIFY_RETRY_BACKOFF_MS documents). A stale snapshot that
      // claims every table still exists made the rebuild skip its CREATEs, so
      // the restore died on the truly-wiped primary with "no such table". The
      // rebuild must not consult the database at all.
      await createTestListing({ name: "Snapshot Lag Survivor" });
      const zip = await createBackupZip();

      const client = getDb();
      const originalBatch = client.batch.bind(client);
      // The full pre-wipe schema, exactly as a lagging snapshot would report
      // it: every table with all its columns, every index, every trigger.
      const preWipeSnapshot = [
        {
          rows: SCHEMA.flatMap(([tbl, table]) =>
            table.columns.map(([col]) => ({ col, tbl })),
          ),
        },
        {
          rows: SCHEMA.flatMap(([, table]) =>
            (table.indexes ?? []).map((index) => ({ name: index.name })),
          ),
        },
        { rows: TRIGGERS.map((trigger) => ({ name: trigger.name })) },
      ] as unknown as ResultSet[];
      const isSnapshotRead = (
        stmts: Array<string | { sql: string }>,
      ): boolean =>
        stmts.some((stmt) => sqlOf(stmt).includes("pragma_table_info"));
      const batchStub = stub(client, "batch", ((
        stmts: Array<string | { sql: string }>,
        mode: unknown,
      ) =>
        isSnapshotRead(stmts)
          ? Promise.resolve(preWipeSnapshot)
          : originalBatch(stmts as never, mode as never)) as never);

      try {
        await restoreFromZip(zip);
      } finally {
        batchStub.restore();
      }

      const listings = await listingsTable.findAll();
      expect(listings.length).toBe(1);
      expect(listings[0]!.name).toBe("Snapshot Lag Survivor");
    });
  });
});
