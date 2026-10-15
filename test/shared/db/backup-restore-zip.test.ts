import type { ResultSet } from "@libsql/client";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { zipSync } from "fflate";
import {
  createBackupZip,
  inspectBackupZip,
  restoreFromZip,
} from "#db/backup.ts";
import { getDb, queryAll } from "#db/client.ts";
import { SCHEMA } from "#db/migrations/schema/index.ts";
import { TRIGGERS } from "#db/migrations/schema/triggers.ts";
import { LATEST_UPDATE, SCHEMA_HASH } from "#db/migrations.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  createTestListing,
  storedListingNames,
} from "#test-utils/db-helpers/listings.ts";

describeWithEnv("backup restoreFromZip", { db: true }, () => {
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
