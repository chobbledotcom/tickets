import { createClient } from "@libsql/client";
import { expect } from "@std/expect";
import { join, toFileUrl } from "@std/path";
import { describe, it as test } from "@std/testing/bdd";
import {
  createDatabaseSnapshot,
  type SnapshotClientFactory,
} from "#scripts/database-snapshot-lib.ts";
import { verifyTursoUploadFile } from "#scripts/turso-migration-file.ts";
import { directoryNames, withTempDir } from "#test-utils/files.ts";

describe("database snapshot", () => {
  test("publishes a complete SQLite database", () =>
    withTempDir(async (dir) => {
      const sourceDirectory = join(dir, "source");
      await Deno.mkdir(sourceDirectory);
      const sourcePath = join(sourceDirectory, "source.sqlite");
      const outputPath = join(dir, "snapshot.sqlite");
      const source = createClient({
        intMode: "bigint",
        url: toFileUrl(sourcePath).href,
      });
      await source.executeMultiple(`
        PRAGMA journal_mode = WAL;
        PRAGMA application_id = 1414090059;
        PRAGMA user_version = 37;
        CREATE TABLE outside_app (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          value INTEGER NOT NULL,
          payload BLOB NOT NULL
        );
        CREATE TABLE audit (outside_id INTEGER NOT NULL);
        CREATE INDEX outside_value_idx ON outside_app (value);
        CREATE VIEW outside_values AS SELECT id, value FROM outside_app;
        CREATE TRIGGER outside_audit AFTER INSERT ON outside_app
        BEGIN
          INSERT INTO audit (outside_id) VALUES (NEW.id);
        END;
      `);
      await source.execute({
        args: [9223372036854775806n, new Uint8Array([0, 127, 128, 255])],
        sql: "INSERT INTO outside_app (value, payload) VALUES (?, ?)",
      });
      await source.execute({
        args: [12n, new Uint8Array([1])],
        sql: "INSERT INTO outside_app (value, payload) VALUES (?, ?)",
      });
      await source.execute("DELETE FROM outside_app WHERE id = 2");
      await source.execute("PRAGMA wal_checkpoint(TRUNCATE)");
      source.close();

      const factory: SnapshotClientFactory = (config) => {
        if (!config.syncUrl) return createClient(config);
        return {
          close: () => {},
          execute: () =>
            Promise.reject(new Error("execute should not be called")),
          sync: async () => {
            await Deno.copyFile(sourcePath, new URL(config.url));
            return {};
          },
        };
      };

      await createDatabaseSnapshot(
        {
          dbToken: "token",
          dbUrl: "libsql://database.example.com",
          outputPath,
        },
        factory,
      );

      expect(await directoryNames(dir)).toEqual(["snapshot.sqlite", "source"]);
      await verifyTursoUploadFile(outputPath, createClient);

      const snapshot = createClient({
        intMode: "bigint",
        url: toFileUrl(outputPath).href,
      });
      try {
        const objects = await snapshot.execute(
          "SELECT type, name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
        );
        expect(objects.rows).toEqual([
          { name: "outside_value_idx", type: "index" },
          { name: "audit", type: "table" },
          { name: "outside_app", type: "table" },
          { name: "outside_audit", type: "trigger" },
          { name: "outside_values", type: "view" },
        ]);
        const values = await snapshot.execute(
          "SELECT id, value, payload FROM outside_app",
        );
        const [stored] = values.rows;
        if (!stored) throw new Error("Snapshot row is missing");
        expect(stored.id).toBe(1n);
        expect(stored.value).toBe(9223372036854775806n);
        expect(stored.payload).toBeInstanceOf(ArrayBuffer);
        if (!(stored.payload instanceof ArrayBuffer)) {
          throw new Error("Snapshot BLOB is not binary data");
        }
        expect(Array.from(new Uint8Array(stored.payload))).toEqual([
          0, 127, 128, 255,
        ]);
        expect((await snapshot.execute("SELECT * FROM audit")).rows).toEqual([
          { outside_id: 1n },
          { outside_id: 2n },
        ]);
        expect(
          (await snapshot.execute("SELECT seq FROM sqlite_sequence")).rows,
        ).toEqual([{ seq: 2n }]);
        expect((await snapshot.execute("PRAGMA application_id")).rows).toEqual([
          { application_id: 1414090059n },
        ]);
        expect((await snapshot.execute("PRAGMA user_version")).rows).toEqual([
          { user_version: 37n },
        ]);
      } finally {
        snapshot.close();
      }
    }));
});
