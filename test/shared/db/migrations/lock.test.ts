import type { InStatement } from "@libsql/client";
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { getDb } from "#shared/db/client.ts";
import { MigrationInProgressError } from "#shared/db/migrations/errors.ts";
import {
  acquireMigrationLock,
  executeWhileMigrationLockOwned,
  releaseAfterMigrationFailure,
  releaseMigrationLock,
  whileMigrationLockOwned,
} from "#shared/db/migrations/lock.ts";
import { MIGRATION_LOCK_KEY } from "#shared/db/migrations/schema/version.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  freshLockStamp,
  LONG_EXPIRED_LOCK_STAMP,
  takeMigrationLock,
} from "#test-utils/migrations.ts";

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

  const holdFreshLock = (): Promise<void> => holdLockSince(freshLockStamp());

  const clearLock = async (): Promise<void> => {
    await getDb().execute({
      args: [MIGRATION_LOCK_KEY],
      sql: "DELETE FROM settings WHERE key = ?",
    });
  };

  /** Take the lock and check the row now holding it is this lease's own. */
  const expectLeaseStored = async (): Promise<void> => {
    try {
      const lease = await acquireMigrationLock(false);
      if (lease === null)
        throw new Error("the lock was not free for this test");

      expect(lease.stored).toBe(true);
      expect(await heldLock()).toBe(lease.token);
    } finally {
      await clearLock();
    }
  };

  test("acquiring stores this request's lease", async () => {
    await expectLeaseStored();
  });

  test("a test that cannot take the lock fails loudly", async () => {
    try {
      await holdFreshLock();

      await expect(takeMigrationLock()).rejects.toThrow(
        "Could not take the migration lock for this test",
      );
    } finally {
      await clearLock();
    }
  });

  test("a lock still inside the time limit is not taken", async () => {
    try {
      await holdFreshLock();

      expect(await acquireMigrationLock(false)).toBeNull();
    } finally {
      await clearLock();
    }
  });

  test("a lock older than the time limit is stolen", async () => {
    await holdLockSince(LONG_EXPIRED_LOCK_STAMP);

    await expectLeaseStored();
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
    const lockToken = await takeMigrationLock();

    await releaseMigrationLock(lockToken);

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
    const lockToken = await takeMigrationLock();
    try {
      await executeWhileMigrationLockOwned(
        [
          whileMigrationLockOwned(
            "INSERT OR REPLACE INTO settings (key, value) SELECT ?, ?",
            ["lock_test_marker", "written"],
            lockToken,
          ),
        ],
        lockToken,
      );

      const result = await getDb().execute(
        "SELECT value FROM settings WHERE key = 'lock_test_marker'",
      );
      expect(result.rows[0]?.value).toBe("written");
    } finally {
      await getDb().execute(
        "DELETE FROM settings WHERE key = 'lock_test_marker'",
      );
      await releaseMigrationLock(lockToken);
    }
  });

  test("owned statements are refused once the lease is lost", async () => {
    const lockToken = await takeMigrationLock();
    await clearLock();

    await expect(
      executeWhileMigrationLockOwned(
        [
          whileMigrationLockOwned(
            "INSERT OR REPLACE INTO settings (key, value) SELECT ?, ?",
            ["lock_test_marker", "written"],
            lockToken,
          ),
        ],
        lockToken,
      ),
    ).rejects.toThrow(
      new MigrationInProgressError(
        "Database migration lock ownership was lost before completion.",
      ),
    );

    const result = await getDb().execute(
      "SELECT value FROM settings WHERE key = 'lock_test_marker'",
    );
    expect(result.rows).toEqual([]);
  });

  test("a failed migration gives the lock back and re-raises", async () => {
    const lockToken = await takeMigrationLock();
    const failure = new Error("migration work failed");

    await expect(
      releaseAfterMigrationFailure(lockToken, failure),
    ).rejects.toThrow(failure);
    expect(await heldLock()).toBeNull();
  });

  /** Make the lock INSERT fail the way a database without a settings table
   *  does, leaving every other statement alone. */
  const failLockWriteWith = (message: string) => {
    const client = getDb();
    const execute = client.execute.bind(client);
    return stub(client, "execute", (statement: InStatement) =>
      typeof statement !== "string" &&
      statement.sql.startsWith("INSERT INTO settings")
        ? Promise.reject(new Error(message))
        : execute(statement),
    );
  };

  test("a missing settings table is only tolerated when it is expected", async () => {
    using _execute = failLockWriteWith("no such table: settings");

    // Setup and restore create the table, so they carry on without a lock —
    // and the lease says so, because no row was written to back it.
    expect(await acquireMigrationLock(true)).toEqual({
      stored: false,
      token: expect.any(String),
    });
    // ...but an ordinary request must not treat it as a free lock.
    await expect(acquireMigrationLock(false)).rejects.toThrow(
      "no such table: settings",
    );
  });

  test("any other write failure is raised even when bootstrapping", async () => {
    using _execute = failLockWriteWith("database is locked");

    await expect(acquireMigrationLock(true)).rejects.toThrow(
      "database is locked",
    );
  });
});
