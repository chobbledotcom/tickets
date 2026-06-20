import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { unzipSync, zipSync } from "fflate";
import {
  BACKUP_REQUIRED_WITHIN_MS,
  type BackupManifest,
  backupDir,
  backupKey,
  backupLeaf,
  backupTimestamp,
  countZipStatements,
  createBackup,
  createBackupZip,
  dbName,
  exportTable,
  hasRecentBackup,
  isBackupLeaf,
  isBackupPath,
  isRemoteDatabase,
  parseBackupTime,
  pruneOldBackups,
  readManifest,
  restoreFromSql,
  restoreFromZip,
  splitStatements,
} from "#shared/db/backup.ts";
import { getDb, queryAll } from "#shared/db/client.ts";
import { listingsTable } from "#shared/db/listings.ts";
import {
  initDb,
  SCHEMA_HASH,
  SCHEMA_TABLE_NAMES,
} from "#shared/db/migrations.ts";
import { listFiles, uploadRaw } from "#shared/storage.ts";
import { setDeleteOverride } from "#shared/test-overrides.ts";
import { createTestListing, describeWithEnv, setTestEnv } from "#test-utils";

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
      expect(manifest.latestUpdate).toBeTruthy();
      expect(manifest.timestamp).toBeTruthy();
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

    test("names a database from an explicitly passed URL (another instance)", () => {
      // The per-site upgrade gate passes a built site's own DB URL, not env.
      expect(dbName("libsql://01ABC-client-acme.lite.bunnydb.net/")).toBe(
        "client-acme",
      );
    });
  });

  describe("backupDir", () => {
    test("defaults to the current DB's folder", () => {
      // Test env DB_URL is :memory:, so dbName() falls back to "local".
      expect(backupDir()).toBe("local/");
    });

    test("scopes to a named database when given one", () => {
      expect(backupDir(dbName("libsql://01-client-acme.turso.io"))).toBe(
        "client-acme/",
      );
    });

    test("a name that extends another is a distinct folder, not a prefix", () => {
      // The exact bug this scheme prevents: "tickets" must not be a string
      // prefix that swallows "tickets-spencer". As folders, the "/" boundary
      // keeps them separate.
      expect(backupDir("tickets")).toBe("tickets/");
      expect(backupDir("tickets-spencer")).toBe("tickets-spencer/");
      expect(
        backupDir("tickets-spencer").startsWith(backupDir("tickets")),
      ).toBe(false);
    });
  });

  describe("backupLeaf / backupKey / backupTimestamp", () => {
    test("backupLeaf names the file with .zip extension, no folder", () => {
      expect(backupLeaf("2024-01-15T12-30-00-000Z")).toBe(
        "backup-2024-01-15T12-30-00-000Z.zip",
      );
    });

    test("backupKey nests the leaf inside the current DB's folder", () => {
      // In test env, DB_URL is :memory: so dbName() returns "local".
      expect(backupKey("2024-01-15T12-30-00-000Z")).toBe(
        "local/backup-2024-01-15T12-30-00-000Z.zip",
      );
    });

    test("backupKey scopes to a named database when given one", () => {
      expect(backupKey("2024-01-15T12-30-00-000Z", "client-acme")).toBe(
        "client-acme/backup-2024-01-15T12-30-00-000Z.zip",
      );
    });

    test("returns ISO-like timestamp with dashes", () => {
      expect(backupTimestamp()).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/,
      );
    });
  });

  describe("isBackupLeaf / isBackupPath", () => {
    const leaf = backupLeaf(backupTimestamp(new Date("2024-01-15T12:30:00Z")));

    test("isBackupLeaf accepts an exact backup leaf", () => {
      expect(isBackupLeaf(leaf)).toBe(true);
    });

    test("isBackupLeaf rejects non-backup or malformed leaves", () => {
      expect(isBackupLeaf("restore-pending-abc.zip")).toBe(false);
      expect(isBackupLeaf("backup-not-a-date.zip")).toBe(false);
      expect(isBackupLeaf("notes.txt")).toBe(false);
    });

    test("isBackupLeaf rejects anything carrying a path separator", () => {
      // The download route relies on this to refuse traversal payloads.
      expect(isBackupLeaf(`local/${leaf}`)).toBe(false);
      expect(isBackupLeaf(`../${leaf}`)).toBe(false);
    });

    test("isBackupPath matches a backup by its leaf, ignoring the folder", () => {
      expect(
        isBackupPath(backupKey(backupTimestamp(), "tickets-spencer")),
      ).toBe(true);
      expect(isBackupPath("local/restore-pending-abc.zip")).toBe(false);
      expect(isBackupPath("local/notes.txt")).toBe(false);
    });
  });

  describe("parseBackupTime", () => {
    test("round-trips a key produced by backupKey/backupTimestamp", () => {
      const when = new Date("2024-01-15T12:30:00.000Z");
      const filename = backupKey(backupTimestamp(when));
      expect(parseBackupTime(filename)).toBe(when.getTime());
    });

    test("returns null for filenames that are not backups", () => {
      expect(parseBackupTime("image.png")).toBeNull();
      expect(parseBackupTime("local/backup-not-a-date.zip")).toBeNull();
    });

    test("returns null when the digits form an impossible date", () => {
      expect(
        parseBackupTime("local/backup-2024-13-45T99-99-99-999Z.zip"),
      ).toBeNull();
    });
  });

  describe("hasRecentBackup", () => {
    const seedBackup = (when: Date) =>
      uploadRaw(new Uint8Array([1]), backupKey(backupTimestamp(when)));

    test("true when a backup is within the freshness window", async () => {
      const tmpDir = Deno.makeTempDirSync();
      const restore = setTestEnv({ LOCAL_STORAGE_PATH: tmpDir });
      try {
        await seedBackup(new Date(Date.now() - 60_000));
        expect(await hasRecentBackup()).toBe(true);
      } finally {
        restore();
        Deno.removeSync(tmpDir, { recursive: true });
      }
    });

    test("false when the newest backup is older than the window", async () => {
      const tmpDir = Deno.makeTempDirSync();
      const restore = setTestEnv({ LOCAL_STORAGE_PATH: tmpDir });
      try {
        await seedBackup(
          new Date(Date.now() - BACKUP_REQUIRED_WITHIN_MS - 60_000),
        );
        expect(await hasRecentBackup()).toBe(false);
      } finally {
        restore();
        Deno.removeSync(tmpDir, { recursive: true });
      }
    });

    test("checks a passed maxAge and name (another instance's backup)", async () => {
      const tmpDir = Deno.makeTempDirSync();
      const restore = setTestEnv({ LOCAL_STORAGE_PATH: tmpDir });
      try {
        const site = dbName("libsql://01-client-acme.lite.bunnydb.net");
        await uploadRaw(
          new Uint8Array([1]),
          backupKey(backupTimestamp(new Date(Date.now() - 60_000)), site),
        );
        // Found under the site's folder, but not under the current DB's.
        expect(await hasRecentBackup(60 * 60 * 1000, site)).toBe(true);
        expect(await hasRecentBackup(60 * 60 * 1000)).toBe(false);
      } finally {
        restore();
        Deno.removeSync(tmpDir, { recursive: true });
      }
    });

    test("a site's backup never satisfies a site whose name it extends", async () => {
      // The reported bug: "tickets" must not pick up "tickets-spencer"'s
      // backups just because one name is a string prefix of the other.
      const tmpDir = Deno.makeTempDirSync();
      const restore = setTestEnv({ LOCAL_STORAGE_PATH: tmpDir });
      try {
        await uploadRaw(
          new Uint8Array([1]),
          backupKey(
            backupTimestamp(new Date(Date.now() - 60_000)),
            "tickets-spencer",
          ),
        );
        expect(await hasRecentBackup(60 * 60 * 1000, "tickets-spencer")).toBe(
          true,
        );
        expect(await hasRecentBackup(60 * 60 * 1000, "tickets")).toBe(false);
      } finally {
        restore();
        Deno.removeSync(tmpDir, { recursive: true });
      }
    });

    test("false when no backups exist", async () => {
      const tmpDir = Deno.makeTempDirSync();
      const restore = setTestEnv({ LOCAL_STORAGE_PATH: tmpDir });
      try {
        expect(await hasRecentBackup()).toBe(false);
      } finally {
        restore();
        Deno.removeSync(tmpDir, { recursive: true });
      }
    });

    test("ignores files in the folder that are not valid backups", async () => {
      const tmpDir = Deno.makeTempDirSync();
      const restore = setTestEnv({ LOCAL_STORAGE_PATH: tmpDir });
      try {
        // A fresh file with a valid timestamp tail but not a "backup-…" name
        // must NOT satisfy the gate — parseBackupTime alone would accept it, so
        // the recency check filters to real backups first.
        await uploadRaw(
          new Uint8Array([1]),
          `${backupDir()}manual-${backupTimestamp()}.zip`,
        );
        expect(await hasRecentBackup()).toBe(false);
      } finally {
        restore();
        Deno.removeSync(tmpDir, { recursive: true });
      }
    });
  });

  describe("pruneOldBackups", () => {
    const seed = (when: Date) =>
      uploadRaw(new Uint8Array([1]), backupKey(backupTimestamp(when)));

    test("removes the oldest backups beyond the keep count, ignoring non-backup files", async () => {
      const tmpDir = Deno.makeTempDirSync();
      const restore = setTestEnv({ LOCAL_STORAGE_PATH: tmpDir });
      try {
        const d1 = new Date("2024-01-01T00:00:00Z");
        const d2 = new Date("2024-02-01T00:00:00Z");
        const d3 = new Date("2024-03-01T00:00:00Z");
        await seed(d1);
        await seed(d2);
        await seed(d3);
        // A non-backup file in the same folder is ignored entirely.
        await uploadRaw(new Uint8Array([1]), `${backupDir()}notes.txt`);

        const removed = await pruneOldBackups(2);

        expect(removed).toEqual([backupKey(backupTimestamp(d1))]);

        const remaining = await listFiles(backupDir());
        expect(remaining).toEqual([
          backupKey(backupTimestamp(d2)),
          backupKey(backupTimestamp(d3)),
          `${backupDir()}notes.txt`,
        ]);
      } finally {
        restore();
        Deno.removeSync(tmpDir, { recursive: true });
      }
    });

    test("keeps everything when the count is within the limit", async () => {
      const tmpDir = Deno.makeTempDirSync();
      const restore = setTestEnv({ LOCAL_STORAGE_PATH: tmpDir });
      try {
        await seed(new Date("2024-01-01T00:00:00Z"));
        const removed = await pruneOldBackups(5);
        expect(removed).toEqual([]);
      } finally {
        restore();
        Deno.removeSync(tmpDir, { recursive: true });
      }
    });

    test("never throws when a delete fails, returning no removed files", async () => {
      const tmpDir = Deno.makeTempDirSync();
      const restore = setTestEnv({ LOCAL_STORAGE_PATH: tmpDir });
      try {
        await seed(new Date("2024-01-01T00:00:00Z"));
        await seed(new Date("2024-02-01T00:00:00Z"));
        setDeleteOverride(new Error("forced delete failure"));
        try {
          const removed = await pruneOldBackups(0);
          expect(removed).toEqual([]);
        } finally {
          setDeleteOverride(null);
        }
        // Both backups survive the failed purge attempt.
        const remaining = await listFiles(backupDir());
        expect(remaining).toHaveLength(2);
      } finally {
        restore();
        Deno.removeSync(tmpDir, { recursive: true });
      }
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
