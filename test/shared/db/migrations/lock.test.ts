import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getDb } from "#shared/db/client.ts";
import { MigrationInProgressError } from "#shared/db/migrations/errors.ts";
import {
  acquireMigrationLock,
  executeWhileMigrationLockOwned,
  MIGRATION_LOCK_TTL_MS,
  releaseAfterMigrationFailure,
  releaseMigrationLock,
  whileMigrationLockOwned,
} from "#shared/db/migrations/lock.ts";
import { MIGRATION_LOCK_KEY } from "#shared/db/migrations/schema/version.ts";
import { describeWithEnv } from "#test-utils/db.ts";

describeWithEnv("db > migrations > lock", { db: true }, () => {
  const heldLock = async (): Promise<string | null> => {
    const result = await getDb().execute({
      args: [MIGRATION_LOCK_KEY],
      sql: "SELECT value FROM settings WHERE key = ?",
    });
    return (result.rows[0]?.value as string) ?? null;
  };

  const holdLockSince = async (stamp: string): Promise<void> => {
    await getDb().execute({
      args: [MIGRATION_LOCK_KEY, stamp],
      sql: "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
    });
  };

  const clearLock = async (): Promise<void> => {
    await getDb().execute({
      args: [MIGRATION_LOCK_KEY],
      sql: "DELETE FROM settings WHERE key = ?",
    });
  };

  test("acquiring stores this request's lease", async () => {
    try {
      const lockToken = await acquireMigrationLock(false);

      expect(await heldLock()).toBe(lockToken);
    } finally {
      await clearLock();
    }
  });

  test("a fresh lock held by someone else is not taken", async () => {
    try {
      await holdLockSince(new Date().toISOString());

      expect(await acquireMigrationLock(false)).toBeNull();
    } finally {
      await clearLock();
    }
  });

  test("a lock older than the time limit is stolen", async () => {
    try {
      const expired = new Date(
        Date.now() - MIGRATION_LOCK_TTL_MS - 1000,
      ).toISOString();
      await holdLockSince(expired);

      const lockToken = await acquireMigrationLock(false);

      expect(lockToken).not.toBeNull();
      expect(await heldLock()).toBe(lockToken);
    } finally {
      await clearLock();
    }
  });

  test("releasing leaves another request's lease alone", async () => {
    try {
      const held = new Date().toISOString();
      await holdLockSince(held);

      await releaseMigrationLock("someone-elses-token");

      expect(await heldLock()).toBe(held);
    } finally {
      await clearLock();
    }
  });

  test("releasing removes this request's own lease", async () => {
    const lockToken = await acquireMigrationLock(false);

    await releaseMigrationLock(lockToken!);

    expect(await heldLock()).toBeNull();
  });

  test("a statement only runs while the lease is still held", () => {
    const statement = whileMigrationLockOwned(
      "INSERT INTO settings (key, value) SELECT ?, ?",
      ["a", "b"],
      "token",
    );

    expect(statement.args).toEqual(["a", "b", MIGRATION_LOCK_KEY, "token"]);
    expect(statement.sql).toBe(
      "INSERT INTO settings (key, value) SELECT ?, ? " +
        "WHERE EXISTS (SELECT 1 FROM settings WHERE key = ? AND value = ?)",
    );
  });

  test("owned statements are written while the lease is held", async () => {
    const lockToken = await acquireMigrationLock(false);
    try {
      await executeWhileMigrationLockOwned(
        [
          whileMigrationLockOwned(
            "INSERT OR REPLACE INTO settings (key, value) SELECT ?, ?",
            ["lock_test_marker", "written"],
            lockToken!,
          ),
        ],
        lockToken!,
      );

      const result = await getDb().execute(
        "SELECT value FROM settings WHERE key = 'lock_test_marker'",
      );
      expect(result.rows[0]?.value).toBe("written");
    } finally {
      await getDb().execute(
        "DELETE FROM settings WHERE key = 'lock_test_marker'",
      );
      await releaseMigrationLock(lockToken!);
    }
  });

  test("owned statements are refused once the lease is lost", async () => {
    const lockToken = await acquireMigrationLock(false);
    await clearLock();

    await expect(
      executeWhileMigrationLockOwned(
        [
          whileMigrationLockOwned(
            "INSERT OR REPLACE INTO settings (key, value) SELECT ?, ?",
            ["lock_test_marker", "written"],
            lockToken!,
          ),
        ],
        lockToken!,
      ),
    ).rejects.toThrow(MigrationInProgressError);

    const result = await getDb().execute(
      "SELECT value FROM settings WHERE key = 'lock_test_marker'",
    );
    expect(result.rows).toEqual([]);
  });

  test("a failed migration gives the lock back and re-raises", async () => {
    const lockToken = await acquireMigrationLock(false);
    const failure = new Error("migration work failed");

    await expect(
      releaseAfterMigrationFailure(lockToken!, failure),
    ).rejects.toThrow(failure);
    expect(await heldLock()).toBeNull();
  });
});
