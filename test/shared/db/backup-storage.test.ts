import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { FakeTime } from "@std/testing/time";
import {
  BACKUP_REQUIRED_WITHIN_MS,
  backupDir,
  backupKey,
  backupLeaf,
  backupTimestamp,
  dbName,
  hasRecentBackup,
  isBackupLeaf,
  isBackupPath,
  isRemoteDatabase,
  parseBackupTime,
  pruneOldBackups,
} from "#db/backup-storage.ts";
import { listFiles, uploadRaw } from "#shared/storage.ts";
import { setDeleteOverride } from "#shared/test-overrides.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { withEnv } from "#test-utils/env.ts";
import { tempDir } from "#test-utils/files.ts";

describeWithEnv("backup storage", { db: true }, () => {
  describe("dbName", () => {
    test("returns 'local' for in-memory databases", () => {
      using _env = withEnv({ DB_URL: ":memory:" });
      expect(dbName()).toBe("local");
    });

    test("extracts name from libsql:// URL", () => {
      using _env = withEnv({
        DB_URL:
          "libsql://01KFXBFGMADR58XZ2PBX7HCB5Y-tickets-spencer.lite.bunnydb.net/",
      });
      expect(dbName()).toBe("tickets-spencer");
    });

    test("uses full first segment for Turso URLs (db-name and org are both unique identity)", () => {
      using _env = withEnv({
        DB_URL: "https://my-site-myorg.turso.io",
      });
      expect(dbName()).toBe("my-site-myorg");
    });

    test("drops only the part before the first dash", () => {
      using _env = withEnv({ DB_URL: "libsql://a-tickets.lite.bunnydb.net" });
      expect(dbName()).toBe("tickets");
    });

    test("returns full hostname segment when no dash", () => {
      using _env = withEnv({ DB_URL: "libsql://standalone.turso.io" });
      expect(dbName()).toBe("standalone");
    });

    test("returns 'local' for invalid URLs", () => {
      using _env = withEnv({ DB_URL: "not-a-url" });
      expect(dbName()).toBe("local");
    });

    test("names a database from an explicitly passed URL (another instance)", () => {
      // The per-site upgrade gate passes a built site's own DB URL, not env.
      expect(dbName("libsql://01ABC-client-acme.lite.bunnydb.net/")).toBe(
        "client-acme",
      );
    });

    test("files a parseable local file: URL under 'local'", () => {
      // An empty name would put backups under a bare "/" folder.
      expect(dbName("file:database.db")).toBe("local");
    });

    test("keeps the full first segment for hosts it does not recognise", () => {
      // Only Bunny's lite hostnames carry a UUID prefix to drop. Stripping
      // the first dashed part from other hosts would file distinct databases
      // in one folder — "alpha-db" and "beta-db" must not both become "db".
      expect(dbName("https://alpha-db.example.com")).toBe("alpha-db");
      expect(dbName("https://beta-db.example.com")).toBe("beta-db");
    });

    test("keeps the full first segment for a Bunny hostname outside the lite shape", () => {
      // Only {uuid}-{name}.lite.bunnydb.net addresses carry a UUID prefix;
      // any other Bunny-owned hostname must not lose its first dashed part.
      expect(dbName("libsql://alpha-db.bunnydb.net")).toBe("alpha-db");
    });

    test("returns the full segment for a Bunny hostname with no dash", () => {
      expect(dbName("libsql://tickets.lite.bunnydb.net")).toBe("tickets");
    });
  });

  describe("backupDir", () => {
    test("defaults to the current DB's folder", () => {
      // An in-memory DB_URL makes dbName() fall back to "local".
      using _env = withEnv({ DB_URL: ":memory:" });
      expect(backupDir()).toBe("local/");
    });

    test("scopes to a named database when given one", () => {
      expect(backupDir(dbName("libsql://client-acme-myorg.turso.io"))).toBe(
        "client-acme-myorg/",
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
      // An in-memory DB_URL makes dbName() return "local".
      using _env = withEnv({ DB_URL: ":memory:" });
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

    const MAX = BACKUP_REQUIRED_WITHIN_MS;
    const NOW = new Date("2024-06-01T12:00:00.000Z").getTime();
    // Deliberately restates the documented five-minute skew allowance rather
    // than importing it, so changing the allowance is a conscious test edit.
    const SKEW = 5 * 60 * 1000;

    // Pins the clock at NOW so the freshness boundaries are exact.
    const gateWithBackupAt = async (takenAtMs: number): Promise<boolean> => {
      using _time = new FakeTime(NOW);
      using tmpDir = tempDir();
      using _env = withEnv({ LOCAL_STORAGE_PATH: tmpDir.path });
      await seedBackup(new Date(takenAtMs));
      return await hasRecentBackup();
    };

    test("fresh from the moment it is taken until the window closes", async () => {
      expect(await gateWithBackupAt(NOW)).toBe(true);
      expect(await gateWithBackupAt(NOW - MAX + 1)).toBe(true);
    });

    test("no longer fresh exactly at the window edge", async () => {
      expect(await gateWithBackupAt(NOW - MAX)).toBe(false);
    });

    test("tolerates a backup dated ahead of the clock up to the skew allowance", async () => {
      // Out-of-band backups come from machines whose clocks can run a
      // little ahead; a just-taken backup must still open the gate.
      expect(await gateWithBackupAt(NOW + SKEW)).toBe(true);
    });

    test("rejects a backup dated further ahead than the skew allowance", async () => {
      // A wrongly future-dated file must not satisfy the gate — a negative
      // age is not a young age.
      expect(await gateWithBackupAt(NOW + SKEW + 1)).toBe(false);
    });

    test("true when a backup is within the freshness window", async () => {
      using tmpDir = tempDir();
      using _env = withEnv({ LOCAL_STORAGE_PATH: tmpDir.path });
      await seedBackup(new Date(Date.now() - 60_000));
      expect(await hasRecentBackup()).toBe(true);
    });

    test("false when the newest backup is older than the window", async () => {
      using tmpDir = tempDir();
      using _env = withEnv({ LOCAL_STORAGE_PATH: tmpDir.path });
      await seedBackup(
        new Date(Date.now() - BACKUP_REQUIRED_WITHIN_MS - 60_000),
      );
      expect(await hasRecentBackup()).toBe(false);
    });

    test("checks a passed maxAge and name (another instance's backup)", async () => {
      using tmpDir = tempDir();
      using _env = withEnv({ LOCAL_STORAGE_PATH: tmpDir.path });
      const site = dbName("libsql://01-client-acme.lite.bunnydb.net");
      await uploadRaw(
        new Uint8Array([1]),
        backupKey(backupTimestamp(new Date(Date.now() - 60_000)), site),
      );
      // Found under the site's folder, but not under the current DB's.
      expect(await hasRecentBackup(60 * 60 * 1000, site)).toBe(true);
      expect(await hasRecentBackup(60 * 60 * 1000)).toBe(false);
    });

    test("a site's backup never satisfies a site whose name it extends", async () => {
      // The reported bug: "tickets" must not pick up "tickets-spencer"'s
      // backups just because one name is a string prefix of the other.
      using tmpDir = tempDir();
      using _env = withEnv({ LOCAL_STORAGE_PATH: tmpDir.path });
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
    });

    test("false when no backups exist", async () => {
      using tmpDir = tempDir();
      using _env = withEnv({ LOCAL_STORAGE_PATH: tmpDir.path });
      expect(await hasRecentBackup()).toBe(false);
    });

    test("ignores files in the folder that are not valid backups", async () => {
      using tmpDir = tempDir();
      using _env = withEnv({ LOCAL_STORAGE_PATH: tmpDir.path });
      // A fresh file with a valid timestamp tail but not a "backup-…" name
      // must NOT satisfy the gate — parseBackupTime alone would accept it, so
      // the recency check filters to real backups first.
      await uploadRaw(
        new Uint8Array([1]),
        `${backupDir()}manual-${backupTimestamp()}.zip`,
      );
      expect(await hasRecentBackup()).toBe(false);
    });
  });

  describe("pruneOldBackups", () => {
    const seed = (when: Date) =>
      uploadRaw(new Uint8Array([1]), backupKey(backupTimestamp(when)));

    test("removes the oldest backups beyond the keep count, ignoring non-backup files", async () => {
      using tmpDir = tempDir();
      using _env = withEnv({ LOCAL_STORAGE_PATH: tmpDir.path });
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
    });

    test("keeps everything when the count is within the limit", async () => {
      using tmpDir = tempDir();
      using _env = withEnv({ LOCAL_STORAGE_PATH: tmpDir.path });
      await seed(new Date("2024-01-01T00:00:00Z"));
      const removed = await pruneOldBackups(5);
      expect(removed).toEqual([]);
    });

    test("never throws when a delete fails, returning no removed files", async () => {
      using tmpDir = tempDir();
      using _env = withEnv({ LOCAL_STORAGE_PATH: tmpDir.path });
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
    });
  });

  describe("isRemoteDatabase", () => {
    test("returns false for local URLs", () => {
      expect(isRemoteDatabase()).toBe(false);
    });

    test("returns true for libsql:// URLs", () => {
      using _env = withEnv({ DB_URL: "libsql://db.turso.io" });
      expect(isRemoteDatabase()).toBe(true);
    });

    test("returns true for https:// URLs", () => {
      using _env = withEnv({ DB_URL: "https://db.turso.io" });
      expect(isRemoteDatabase()).toBe(true);
    });
  });
});
