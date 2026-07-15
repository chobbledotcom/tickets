import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
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
} from "#shared/db/backup-storage.ts";
import { listFiles, uploadRaw } from "#shared/storage.ts";
import { setDeleteOverride } from "#shared/test-overrides.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { setTestEnv } from "#test-utils/env.ts";

describeWithEnv("backup storage", { db: true }, () => {
  describe("dbName", () => {
    test("returns 'local' for in-memory databases", () => {
      const restore = setTestEnv({ DB_URL: ":memory:" });
      try {
        expect(dbName()).toBe("local");
      } finally {
        restore();
      }
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

    test("uses full first segment for Turso URLs (db-name and org are both unique identity)", () => {
      const restore = setTestEnv({
        DB_URL: "https://my-site-myorg.turso.io",
      });
      try {
        expect(dbName()).toBe("my-site-myorg");
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
      // An in-memory DB_URL makes dbName() fall back to "local".
      const restore = setTestEnv({ DB_URL: ":memory:" });
      try {
        expect(backupDir()).toBe("local/");
      } finally {
        restore();
      }
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
      const restore = setTestEnv({ DB_URL: ":memory:" });
      try {
        expect(backupKey("2024-01-15T12-30-00-000Z")).toBe(
          "local/backup-2024-01-15T12-30-00-000Z.zip",
        );
      } finally {
        restore();
      }
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
