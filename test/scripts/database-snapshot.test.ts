import { type Config, createClient } from "@libsql/client";
import { expect } from "@std/expect";
import { fromFileUrl, join, toFileUrl } from "@std/path";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import {
  createDatabaseSnapshot,
  type SnapshotClient,
  type SnapshotClientFactory,
  type SnapshotRequest,
} from "#scripts/database-snapshot-lib.ts";
import { pathExists, withTempDir } from "#test-utils/files.ts";

const request = (outputPath: string): SnapshotRequest => ({
  dbToken: "token",
  dbUrl: "libsql://database.example.com",
  outputPath,
});

const unusedExecute = (): Promise<never> =>
  Promise.reject(new Error("execute should not be called"));

const unusedSync = (): Promise<never> =>
  Promise.reject(new Error("sync should not be called"));

const replicaClient = (
  sync: () => Promise<unknown>,
  close: () => void = () => {},
): SnapshotClient => ({ close, execute: unusedExecute, sync });

const localClient = (
  execute: SnapshotClient["execute"],
  close: () => void = () => {},
): SnapshotClient => ({ close, execute, sync: unusedSync });

const rows = (values: Record<string, unknown>[]) =>
  Promise.resolve({ rows: values });

const checkpointOk = { busy: 0, checkpointed: 0, log: 0 };
const integrityOk = { integrity_check: "ok" };

const fakeDatabaseFactory = (
  onSync: (path: string) => void | Promise<void>,
  localRows: Record<string, unknown>[][],
  onLocalClose: (path: string) => void = () => {},
): SnapshotClientFactory => {
  let localCall = 0;
  return (config: Config): SnapshotClient => {
    const path = fromFileUrl(config.url);
    if (config.syncUrl) {
      return replicaClient(async () => {
        await onSync(path);
        return {};
      });
    }
    return localClient(
      () => rows(localRows[localCall++] ?? []),
      () => onLocalClose(path),
    );
  };
};

const directoryNames = async (path: string): Promise<string[]> => {
  const names: string[] = [];
  for await (const entry of Deno.readDir(path)) names.push(entry.name);
  return names.sort();
};

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

      const factory: SnapshotClientFactory = (config) =>
        config.syncUrl
          ? replicaClient(async () => {
              await Deno.copyFile(sourcePath, fromFileUrl(config.url));
              return {};
            })
          : createClient(config);

      await createDatabaseSnapshot(request(outputPath), factory);

      expect(await directoryNames(dir)).toEqual(["snapshot.sqlite", "source"]);

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

  test("refuses an existing output before syncing", () =>
    withTempDir(async (dir) => {
      const outputPath = join(dir, "snapshot.sqlite");
      await Deno.writeTextFile(outputPath, "keep me");
      let clientCreated = false;

      await expect(
        createDatabaseSnapshot(request(outputPath), () => {
          clientCreated = true;
          return replicaClient(unusedSync);
        }),
      ).rejects.toThrow(`Output already exists: ${outputPath}`);

      expect(clientCreated).toBe(false);
      expect(await Deno.readTextFile(outputPath)).toBe("keep me");
    }));

  test("rejects a missing output directory before syncing", () =>
    withTempDir(async (dir) => {
      const parentPath = join(dir, "missing");
      await expect(
        createDatabaseSnapshot(
          request(join(parentPath, "snapshot.sqlite")),
          () => replicaClient(unusedSync),
        ),
      ).rejects.toThrow(`Output directory does not exist: ${parentPath}`);
    }));

  test("rejects an output parent that is not a directory", () =>
    withTempDir(async (dir) => {
      const parentPath = join(dir, "file");
      await Deno.writeTextFile(parentPath, "not a directory");
      await expect(
        createDatabaseSnapshot(
          request(join(parentPath, "snapshot.sqlite")),
          () => replicaClient(unusedSync),
        ),
      ).rejects.toThrow(`Output directory is not a directory: ${parentPath}`);
    }));

  test("surfaces output directory read errors", () =>
    withTempDir(async (dir) => {
      const readError = new Deno.errors.PermissionDenied("blocked");
      using _stat = stub(Deno, "stat", () => Promise.reject(readError));

      await expect(
        createDatabaseSnapshot(request(join(dir, "snapshot.sqlite")), () =>
          replicaClient(unusedSync),
        ),
      ).rejects.toBe(readError);
    }));

  test("does not overwrite an output created while syncing", () =>
    withTempDir(async (dir) => {
      const outputPath = join(dir, "snapshot.sqlite");
      const factory = fakeDatabaseFactory(
        async (path) => {
          await Deno.writeTextFile(path, "new snapshot");
          await Deno.writeTextFile(outputPath, "racing output");
        },
        [[checkpointOk], [integrityOk]],
      );

      await expect(
        createDatabaseSnapshot(request(outputPath), factory),
      ).rejects.toThrow(`Output already exists: ${outputPath}`);

      expect(await Deno.readTextFile(outputPath)).toBe("racing output");
      expect(await directoryNames(dir)).toEqual(["snapshot.sqlite"]);
    }));

  test("closes the replica and cleans temporary files when sync fails", () =>
    withTempDir(async (dir) => {
      const outputPath = join(dir, "snapshot.sqlite");
      const syncError = new Error("sync failed");
      let closed = false;
      const factory: SnapshotClientFactory = (config) =>
        replicaClient(
          async () => {
            await Deno.writeTextFile(fromFileUrl(config.url), "partial");
            throw syncError;
          },
          () => {
            closed = true;
          },
        );

      await expect(
        createDatabaseSnapshot(request(outputPath), factory),
      ).rejects.toBe(syncError);

      expect(closed).toBe(true);
      expect(await directoryNames(dir)).toEqual([]);
    }));

  test("rejects a busy WAL checkpoint and cleans temporary files", () =>
    withTempDir(async (dir) => {
      const outputPath = join(dir, "snapshot.sqlite");
      const factory = fakeDatabaseFactory(
        (path) => Deno.writeTextFile(path, "partial"),
        [[{ busy: 1, checkpointed: 2, log: 3 }]],
      );

      await expect(
        createDatabaseSnapshot(request(outputPath), factory),
      ).rejects.toThrow("Database snapshot checkpoint did not empty the WAL");

      expect(await directoryNames(dir)).toEqual([]);
    }));

  test("rejects an invalid integrity result and cleans temporary files", () =>
    withTempDir(async (dir) => {
      const outputPath = join(dir, "snapshot.sqlite");
      const factory = fakeDatabaseFactory(
        (path) => Deno.writeTextFile(path, "partial"),
        [[checkpointOk], [{ integrity_check: "page 4 is corrupt" }]],
      );

      await expect(
        createDatabaseSnapshot(request(outputPath), factory),
      ).rejects.toThrow("Database snapshot integrity check failed");

      expect(await directoryNames(dir)).toEqual([]);
    }));

  test("rejects WAL frames left after checkpoint and cleans temporary files", () =>
    withTempDir(async (dir) => {
      const outputPath = join(dir, "snapshot.sqlite");
      const factory = fakeDatabaseFactory(
        (path) => Deno.writeTextFile(path, "partial"),
        [[checkpointOk], [integrityOk]],
        (path) => Deno.writeTextFileSync(`${path}-wal`, "remaining frame"),
      );

      await expect(
        createDatabaseSnapshot(request(outputPath), factory),
      ).rejects.toThrow("Database snapshot WAL is not empty");

      expect(await pathExists(outputPath)).toBe(false);
      expect(await directoryNames(dir)).toEqual([]);
    }));

  test("surfaces atomic publication errors and cleans temporary files", () =>
    withTempDir(async (dir) => {
      const outputPath = join(dir, "snapshot.sqlite");
      const linkError = new Deno.errors.PermissionDenied("links blocked");
      const factory = fakeDatabaseFactory(
        (path) => Deno.writeTextFile(path, "complete"),
        [[checkpointOk], [integrityOk]],
      );
      using _link = stub(Deno, "link", () => Promise.reject(linkError));

      await expect(
        createDatabaseSnapshot(request(outputPath), factory),
      ).rejects.toBe(linkError);

      expect(await pathExists(outputPath)).toBe(false);
      expect(await directoryNames(dir)).toEqual([]);
    }));
});
