import type { ResultSet } from "@libsql/client";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { unzipSync, zipSync } from "fflate";
import {
  type BackupManifest,
  createBackupZip,
  inspectBackupZip,
  PostResetError,
  restoreFromSql,
  restoreFromZip,
  splitStatements,
} from "#shared/db/backup.ts";
import { exportTable } from "#shared/db/backup-snapshot.ts";
import { getDb, queryAll } from "#shared/db/client.ts";
import { SCHEMA } from "#shared/db/migrations/schema/index.ts";
import { TRIGGERS } from "#shared/db/migrations/schema/triggers.ts";
import {
  initDb,
  LATEST_UPDATE,
  SCHEMA_HASH,
  SCHEMA_TABLE_NAMES,
} from "#shared/db/migrations.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  createTestListing,
  storedListingNames,
} from "#test-utils/db-helpers/listings.ts";

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

    test("normalizes Windows newlines inside quoted values", () => {
      expect(
        splitStatements("INSERT INTO a VALUES ('first\r\nsecond');"),
      ).toEqual(["INSERT INTO a VALUES ('first\nsecond');"]);
    });

    test("returns empty array for empty input", () => {
      expect(splitStatements("")).toHaveLength(0);
      expect(splitStatements("   ")).toHaveLength(0);
    });

    test("handles trailing newline", () => {
      const stmts = splitStatements("INSERT INTO a VALUES (1);\n");
      expect(stmts).toHaveLength(1);
    });

    test("adds a terminator to a final statement that has none", () => {
      expect(splitStatements("mutated")).toEqual(["mutated;"]);
    });

    test("keeps a terminator on the final statement", () => {
      expect(splitStatements("SELECT 1;")).toEqual(["SELECT 1;"]);
    });

    test("ignores empty statements", () => {
      expect(splitStatements(";\nSELECT 1;")).toEqual(["SELECT 1;"]);
    });

    test("keeps semicolon-newlines inside quoted CSS values", () => {
      const cssInsert =
        "INSERT INTO settings (key, value) VALUES ('custom_css', '/* 🐸 Splish-Splash — a bright kids'' theme 🐳 */\n" +
        ":root {\n  --color-bg: #f2fcff;\n  --color-text: #0d3b45;\n}');";
      const nextInsert =
        "INSERT INTO settings (key, value) VALUES ('site_name', 'Frog pond');";

      expect(splitStatements(`${cssInsert}\n${nextInsert}`)).toEqual([
        cssInsert,
        nextInsert,
      ]);
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
      expect(new TextDecoder().decode(files["manifest.json"]!)).toContain(
        '\n  "latestUpdate"',
      );
      // ZIP method 8 is DEFLATE; method 0 would store every entry uncompressed.
      expect(new DataView(zipData.buffer).getUint16(8, true)).toBe(8);
    });
  });

  describe("inspectBackupZip", () => {
    test("reads manifest from backup zip", async () => {
      const { manifest } = inspectBackupZip(await createBackupZip());
      expect(manifest).not.toBeNull();
      expect(manifest!.schemaHash).toBe(SCHEMA_HASH);
    });

    test("returns null for zip without manifest", () => {
      expect(
        inspectBackupZip(
          zipSync({
            "attendee_statuses.sql": new TextEncoder().encode(
              "INSERT INTO attendee_statuses (id) VALUES (1);",
            ),
            "schema_migrations.sql": new TextEncoder().encode(
              "INSERT INTO schema_migrations (id) VALUES ('initial');",
            ),
            "settings.sql": new TextEncoder().encode(
              "INSERT INTO settings (key, value) VALUES ('k', 'v');",
            ),
          }),
        ).manifest,
      ).toBeNull();
    });

    test("rejects a manifest with an invalid shape", () => {
      const encoder = new TextEncoder();
      const zip = zipSync({
        "manifest.json": encoder.encode(JSON.stringify({ wrong: "shape" })),
      });
      expect(() => inspectBackupZip(zip)).toThrow("Backup manifest is invalid");
    });

    test("rejects a manifest missing required fields", () => {
      const encoder = new TextEncoder();
      const zip = zipSync({
        "manifest.json": encoder.encode(
          JSON.stringify({ latestUpdate: "ok", schemaHash: "ok" }),
        ),
      });
      expect(() => inspectBackupZip(zip)).toThrow("Backup manifest is invalid");
    });

    test("rejects an archive with no restorable SQL", () => {
      expect(() => inspectBackupZip(zipSync({}))).toThrow(
        "Backup contains no restorable SQL statements",
      );
    });

    test("lists every populated table whose data is missing", () => {
      const cases = [
        [{ listings: 1 }, "listings"],
        [{ attendees: 2, listings: 1 }, "attendees, listings"],
      ] as const;

      for (const [tables, names] of cases) {
        const zip = zipSync({
          "manifest.json": new TextEncoder().encode(
            JSON.stringify({
              latestUpdate: LATEST_UPDATE,
              schemaHash: SCHEMA_HASH,
              tables,
              timestamp: "2026-07-22T00:00:00.000Z",
            }),
          ),
        });
        expect(() => inspectBackupZip(zip)).toThrow(
          `Backup is missing data for tables: ${names}`,
        );
      }
    });

    test("counts SQL statements across files in zip", async () => {
      await createTestListing({ name: "Count Test" });
      const inspection = inspectBackupZip(await createBackupZip());
      expect(inspection.statementCount).toBeGreaterThanOrEqual(2);
    });
  });

  describe("restoreFromSql", () => {
    const dumpWithFutureMigrations = async (ids: string[]): Promise<string> => {
      const recorded = await exportTable("schema_migrations");
      return `${recorded.sql}\n${ids
        .map(
          (id) =>
            `INSERT INTO "schema_migrations" ("id", "description", "applied_at") VALUES ('${id}', 'Future change', '2099-01-01T00:00:00.000Z');`,
        )
        .join("\n")}`;
    };

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

    test("refuses one future migration before wiping existing data", async () => {
      await createTestListing({ name: "Still here" });

      await expect(
        restoreFromSql(
          await dumpWithFutureMigrations(["2099-01-01_from_the_future"]),
        ),
      ).rejects.toThrow("2099-01-01_from_the_future");
      expect(await storedListingNames()).toEqual(["Still here"]);
    });

    test("explains every future migration and how to proceed", async () => {
      const ids = [
        "2099-01-01_first_future_change",
        "2099-01-02_second_future_change",
      ];
      const error = await restoreFromSql(
        await dumpWithFutureMigrations(ids),
      ).catch((caught: unknown) => caught);

      expect((error as Error).message).toBe(
        "Backup is from a newer version of the app: it records migration(s) " +
          `newer than this build knows (${ids.join(", ")}). ` +
          "Update the site to that version or newer, then restore this backup.",
      );
    });

    test("marks failures after reset with their exact cause", async () => {
      const error = await restoreFromSql("", ({ stage }) => {
        if (stage === "rebuilding") throw new Error("rebuild stopped");
      }).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(PostResetError);
      expect((error as Error).name).toBe("PostResetError");
      expect((error as Error).message).toBe("Error: rebuild stopped");
    });
  });

  describe("restoreFromZip", () => {
    test("round-trips backup and restore", async () => {
      await createTestListing({ name: "Zip Restore Test" });
      const zip = await createBackupZip();
      const progress: Array<{ stage: string; statementCount: number }> = [];
      await restoreFromZip(zip, (event) => progress.push(event));
      expect(await storedListingNames()).toEqual(["Zip Restore Test"]);
      expect(progress.map(({ stage }) => stage)).toEqual([
        "checking",
        "resetting",
        "rebuilding",
        "importing",
        "clearing-caches",
      ]);
      expect(progress.map(({ statementCount }) => statementCount)).toEqual(
        Array(5).fill(inspectBackupZip(zip).statementCount),
      );
    });

    test("preserves CSS with emojis and semicolon-newlines through roundtrip", async () => {
      const css =
        "/* 🐸 Splish-Splash — a bright kids' theme 🐳 */\n\n" +
        ":root {\n  --color-bg: #f2fcff;\n  --color-text: #0d3b45;\n}";
      await getDb().execute({
        args: ["custom_css", css],
        sql: "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
      });
      await restoreFromZip(await createBackupZip());
      const restored = await queryAll<{ value: string }>(
        "SELECT value FROM settings WHERE key = 'custom_css'",
      );
      expect(restored).toEqual([{ value: css }]);
    });

    test("allows a manifest backup to omit empty table files", async () => {
      const encoder = new TextEncoder();
      const partial = zipSync({
        "manifest.json": encoder.encode(
          JSON.stringify({
            latestUpdate: LATEST_UPDATE,
            schemaHash: SCHEMA_HASH,
            tables: { settings: 1 },
            timestamp: "2026-07-22T00:00:00.000Z",
          }),
        ),
        "settings.sql": encoder.encode(
          "INSERT INTO settings (key, value) VALUES ('k', 'v');",
        ),
      });
      await restoreFromZip(partial);
      const rows = await queryAll<{ value: string }>(
        "SELECT value FROM settings WHERE key = 'k'",
      );
      expect(rows[0]!.value).toBe("v");
    });

    test("lists unsupported table data before wiping the database", async () => {
      await createTestListing({ name: "Still here" });
      const cases = [
        [["events"], "events"],
        [["event_attendees", "events"], "event_attendees, events"],
      ] as const;

      for (const [tables, names] of cases) {
        const unsupported = zipSync(
          Object.fromEntries(
            tables.map((table) => [
              `${table}.sql`,
              new TextEncoder().encode(
                `INSERT INTO "${table}" ("id") VALUES (1);`,
              ),
            ]),
          ),
        );
        await expect(restoreFromZip(unsupported)).rejects.toThrow(
          `Backup contains data for tables this app cannot restore: ${names}`,
        );
      }
      expect(await storedListingNames()).toEqual(["Still here"]);
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

      expect(await storedListingNames()).toEqual(["Stale Read Survivor"]);
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

      expect(await storedListingNames()).toEqual(["Snapshot Lag Survivor"]);
    });
  });
});
