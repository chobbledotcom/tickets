import type { Config } from "@libsql/client";
import { expect } from "@std/expect";
import { fromFileUrl, join } from "@std/path";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import {
  createDatabaseSnapshot,
  type SnapshotClient,
  type SnapshotClientFactory,
  type SnapshotRequest,
} from "#scripts/database-snapshot-lib.ts";
import { directoryNames, pathExists, withTempDir } from "#test-utils/files.ts";

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

const expectExistingFilePreserved = async (
  outputPath: string,
  existingPath: string,
  content: string,
  factory: SnapshotClientFactory,
): Promise<void> => {
  await expect(
    createDatabaseSnapshot(request(outputPath), factory),
  ).rejects.toThrow(`Output already exists: ${existingPath}`);
  expect(await Deno.readTextFile(existingPath)).toBe(content);
};

describe("database snapshot safety", () => {
  test("refuses an existing output before syncing", () =>
    withTempDir(async (dir) => {
      const outputPath = join(dir, "snapshot.sqlite");
      await Deno.writeTextFile(outputPath, "keep me");
      let clientCreated = false;

      await expectExistingFilePreserved(
        outputPath,
        outputPath,
        "keep me",
        () => {
          clientCreated = true;
          return replicaClient(unusedSync);
        },
      );

      expect(clientCreated).toBe(false);
    }));

  test("refuses existing SQLite sidecars before syncing", () =>
    withTempDir(async (dir) => {
      for (const suffix of ["-wal", "-shm"]) {
        const outputPath = join(dir, `snapshot${suffix}.sqlite`);
        const sidecarPath = `${outputPath}${suffix}`;
        await Deno.writeTextFile(sidecarPath, "keep me");
        let clientCreated = false;

        await expectExistingFilePreserved(
          outputPath,
          sidecarPath,
          "keep me",
          () => {
            clientCreated = true;
            return replicaClient(unusedSync);
          },
        );

        expect(clientCreated).toBe(false);
      }
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

      await expectExistingFilePreserved(
        outputPath,
        outputPath,
        "racing output",
        factory,
      );
      expect(await directoryNames(dir)).toEqual(["snapshot.sqlite"]);
    }));

  test("does not publish beside a sidecar created while syncing", () =>
    withTempDir(async (dir) => {
      const outputPath = join(dir, "snapshot.sqlite");
      const sidecarPath = `${outputPath}-wal`;
      const factory = fakeDatabaseFactory(
        async (path) => {
          await Deno.writeTextFile(path, "new snapshot");
          await Deno.writeTextFile(sidecarPath, "racing WAL");
        },
        [[checkpointOk], [integrityOk]],
      );

      await expectExistingFilePreserved(
        outputPath,
        sidecarPath,
        "racing WAL",
        factory,
      );
      expect(await pathExists(outputPath)).toBe(false);
    }));

  test("does not overwrite an output created during atomic publication", () =>
    withTempDir(async (dir) => {
      const outputPath = join(dir, "snapshot.sqlite");
      const factory = fakeDatabaseFactory(
        (path) => Deno.writeTextFile(path, "new snapshot"),
        [[checkpointOk], [integrityOk]],
      );
      const link = Deno.link;
      using _link = stub(Deno, "link", async (oldPath, newPath) => {
        await Deno.writeTextFile(newPath, "racing output");
        await link(oldPath, newPath);
      });

      await expectExistingFilePreserved(
        outputPath,
        outputPath,
        "racing output",
        factory,
      );
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

  test("publishes the snapshot with owner-only permissions", () =>
    withTempDir(async (dir) => {
      const outputPath = join(dir, "snapshot.sqlite");
      const factory = fakeDatabaseFactory(
        (path) => Deno.writeTextFile(path, "complete"),
        [[checkpointOk], [integrityOk]],
      );

      await createDatabaseSnapshot(request(outputPath), factory);

      const mode = (await Deno.stat(outputPath)).mode;
      if (mode === null) throw new Error("File mode is unavailable");
      expect(mode & 0o777).toBe(0o600);
    }));
});
