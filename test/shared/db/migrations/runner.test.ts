import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { getDb } from "#db/client.ts";
import { releaseMigrationLock } from "#db/migrations/lock.ts";
import {
  applyMigrationWithRetry,
  baselineCurrentSchemaIfNeeded,
  missingMigrations,
  restoreStaleSchemaMarkers,
  runPendingMigrations,
  VERIFY_RETRY_BACKOFF_MS,
  verifyMigrationWithRetry,
} from "#db/migrations/runner.ts";
import { SCHEMA_HASH } from "#db/migrations/schema/index.ts";
import {
  DB_SCHEMA_HASH_KEY,
  SCHEMA_MIGRATIONS_TABLE,
} from "#db/migrations/schema/version.ts";
import { syncIndexes } from "#db/migrations/schema-sync.ts";
import type { Migration } from "#db/migrations/types.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { debugMessages, useDebugLogSpy } from "#test-utils/debug-log.ts";
import {
  settingsValueOrNull,
  takeMigrationLock,
} from "#test-utils/migrations.ts";
import { withVirtualBackoff } from "#test-utils/virtual-time.ts";

describe("db > migrations > runner", () => {
  const debugSpy = useDebugLogSpy();
  test("waits a little longer before each fresh verify snapshot", () => {
    // The waits are what let a lagging schema settle; zero waits would retry
    // against the same stale snapshot every time.
    expect([...VERIFY_RETRY_BACKOFF_MS]).toEqual([50, 150, 350]);
  });

  describe("verify retry on read-your-writes lag", () => {
    const fakeMigration = (verify: () => Promise<void>): Migration => ({
      description: "fake migration for verify-retry tests",
      id: "fake-verify-retry",
      up: () => Promise.resolve(),
      verify,
    });

    test("retries a transient verify failure and then resolves", async () => {
      let attempts = 0;
      await withVirtualBackoff(() =>
        verifyMigrationWithRetry(
          fakeMigration(() => {
            attempts++;
            // Fail on the first two snapshots (stale schema), succeed on the third.
            return attempts < 3
              ? Promise.reject(
                  new Error("Migration verification failed: missing column(s)"),
                )
              : Promise.resolve();
          }),
        ),
      );
      expect(attempts).toBe(3);
    });

    /** Verify a migration whose schema is genuinely broken, and report how
     *  many times verify() was asked. */
    const verifyAlwaysFailing = async (): Promise<number> => {
      let attempts = 0;
      await expect(
        withVirtualBackoff(() =>
          verifyMigrationWithRetry(
            fakeMigration(() => {
              attempts++;
              return Promise.reject(new Error("genuine schema defect"));
            }),
          ),
        ),
      ).rejects.toThrow("genuine schema defect");
      return attempts;
    };

    test("says which attempt failed, and stays quiet on the last one", async () => {
      await verifyAlwaysFailing();

      const retryLines = debugMessages(debugSpy())
        .map(String)
        .filter((line) => line.includes("fake-verify-retry failed on attempt"));
      // One line per retry that is still to come — the final failure is
      // reported by the throw, not by a "retrying" line.
      expect(
        retryLines.map((line) => line.split("failed on attempt ")[1]?.[0]),
      ).toEqual(["1", "2", "3"]);
    });

    test("rethrows after exhausting every retry", async () => {
      // One initial attempt plus one per backoff entry.
      expect(await verifyAlwaysFailing()).toBe(
        VERIFY_RETRY_BACKOFF_MS.length + 1,
      );
    });
  });

  describe("apply re-runs up() when verify keeps failing", () => {
    const fakeMigration = (overrides: Partial<Migration>): Migration => ({
      description: "fake migration for apply-retry tests",
      id: "fake-apply-retry",
      up: () => Promise.resolve(),
      verify: () => Promise.resolve(),
      ...overrides,
    });

    test("resolves a transient verify-lag without re-running up()", async () => {
      // Pure verify-lag: up() did its work, only verify()'s snapshot lagged.
      // up() must NOT be re-run (it may recopy large tables), so the cheap verify
      // retry alone resolves it.
      let upCalls = 0;
      let attempts = 0;
      await withVirtualBackoff(() =>
        applyMigrationWithRetry(
          fakeMigration({
            up: () => {
              upCalls++;
              return Promise.resolve();
            },
            verify: () => {
              attempts++;
              return attempts < 3
                ? Promise.reject(
                    new Error(
                      "Migration verification failed: missing column(s)",
                    ),
                  )
                : Promise.resolve();
            },
          }),
        ),
      );
      expect(attempts).toBe(3);
      expect(upCalls).toBe(1);
    });

    test("re-runs up() once when verify keeps failing, so a skipped index recovers", async () => {
      // Reproduces the production failure: up()'s syncIndexes ran against a
      // primary snapshot that lagged the table it had just created in the same
      // up(), so it silently skipped the index. Retrying verify() ALONE would
      // fail on every attempt because the index was never created; only re-running
      // up() (which now sees the table) creates it — which is why the failure
      // cleared on the next request. up() is re-run only after a full round of
      // verify retries has failed.
      let upCalls = 0;
      let indexCreated = false;
      await withVirtualBackoff(() =>
        applyMigrationWithRetry(
          fakeMigration({
            up: () => {
              upCalls++;
              // First up() skips the index (lagging snapshot); the second sees the
              // table and creates it.
              if (upCalls >= 2) indexCreated = true;
              return Promise.resolve();
            },
            verify: () =>
              indexCreated
                ? Promise.resolve()
                : Promise.reject(
                    new Error(
                      "Migration verification failed: missing index idx_system_notes_attendee_id",
                    ),
                  ),
          }),
        ),
      );
      // up() ran exactly twice — once initially, once to repair — never per retry.
      expect(upCalls).toBe(2);
      expect(indexCreated).toBe(true);
    });

    test("rethrows the original error after re-running up() once and still failing", async () => {
      let upCalls = 0;
      let verifyAttempts = 0;
      await expect(
        withVirtualBackoff(() =>
          applyMigrationWithRetry(
            fakeMigration({
              up: () => {
                upCalls++;
                return Promise.resolve();
              },
              verify: () => {
                verifyAttempts++;
                return Promise.reject(new Error("genuine schema defect"));
              },
            }),
          ),
        ),
      ).rejects.toThrow("genuine schema defect");
      // A genuine defect re-runs up() exactly once (the bounded repair), not once
      // per retry, and verifies across two full retry rounds.
      expect(upCalls).toBe(2);
      expect(verifyAttempts).toBe(2 * (VERIFY_RETRY_BACKOFF_MS.length + 1));
    });
  });
});

describeWithEnv(
  "db > migrations > runner against a database",
  { db: true },
  () => {
    const FIRST_MIGRATION_ID = "2026-06-11_current_schema";

    const staleSchemaHash = async (): Promise<void> => {
      await getDb().execute(
        `UPDATE settings SET value = 'stale' WHERE key = '${DB_SCHEMA_HASH_KEY}'`,
      );
    };

    const forgetMigration = async (id: string): Promise<void> => {
      await getDb().execute({
        args: [id],
        sql: `DELETE FROM ${SCHEMA_MIGRATIONS_TABLE} WHERE id = ?`,
      });
    };

    /** Deploy a SCHEMA change without its migration: drop an index the current
     *  schema declares, so verification finds the live schema wanting. */
    const breakLiveSchema = (): Promise<unknown> =>
      getDb().execute("DROP INDEX idx_listings_slug_index");

    const debugSpy = useDebugLogSpy();
    const debugLines = (): string[] => debugMessages(debugSpy()).map(String);

    test("only the unrecorded migrations are outstanding", async () => {
      expect(await missingMigrations()).toEqual([]);

      await forgetMigration(FIRST_MIGRATION_ID);
      try {
        expect((await missingMigrations()).map((m) => m.id)).toEqual([
          FIRST_MIGRATION_ID,
        ]);
      } finally {
        await baselineCurrentSchemaIfNeeded();
      }
    });

    test("baselining names how many already-applied migrations it recorded", async () => {
      try {
        await forgetMigration(FIRST_MIGRATION_ID);

        await baselineCurrentSchemaIfNeeded();

        expect(debugLines()).toContain(
          "[Migration] Baselining 1 already-applied migration(s)",
        );
        expect(await missingMigrations()).toEqual([]);
      } finally {
        await baselineCurrentSchemaIfNeeded();
      }
    });

    test("baselining refuses to vouch for a schema that does not match", async () => {
      await forgetMigration(FIRST_MIGRATION_ID);
      await breakLiveSchema();
      try {
        await expect(baselineCurrentSchemaIfNeeded()).rejects.toThrow(
          "missing index idx_listings_slug_index",
        );
        // The missing migration is still missing: nothing was vouched for.
        expect((await missingMigrations()).map((m) => m.id)).toEqual([
          FIRST_MIGRATION_ID,
        ]);
      } finally {
        await syncIndexes();
        await baselineCurrentSchemaIfNeeded();
      }
    });

    test("running a migration says which one is running", async () => {
      const lockToken = await takeMigrationLock();
      try {
        await runPendingMigrations(
          [
            {
              description: "runner test migration",
              id: "runner-test-migration",
              up: () => Promise.resolve(),
              verify: () => Promise.resolve(),
            },
          ],
          lockToken,
        );

        expect(debugLines()).toContain(
          "[Migration] Running runner-test-migration: runner test migration",
        );
      } finally {
        await releaseMigrationLock(lockToken);
      }
    });

    test("reports the failure and the lost progress together", async () => {
      // The lease is not held, so recording the finished migration fails too.
      const error = await runPendingMigrations(
        [
          {
            description: "first migration, succeeds",
            id: "runner-progress-ok",
            up: () => Promise.resolve(),
            verify: () => Promise.resolve(),
          },
          {
            description: "second migration, fails",
            id: "runner-progress-fails",
            up: () => Promise.reject(new Error("migration work failed")),
            verify: () => Promise.resolve(),
          },
        ],
        "a-lease-nobody-holds",
      ).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).message).toBe(
        "Database migration failed and completed progress could not be recorded.",
      );
    });

    test("records the finished migrations then rethrows the failure", async () => {
      // The lease IS held, so the finished migration's progress is recorded;
      // the original failure is what surfaces, not a recording error.
      const lockToken = await takeMigrationLock();
      try {
        const error = await runPendingMigrations(
          [
            {
              description: "first migration, succeeds",
              id: "runner-progress-recorded",
              up: () => Promise.resolve(),
              verify: () => Promise.resolve(),
            },
            {
              description: "second migration, fails",
              id: "runner-progress-second-fails",
              up: () => Promise.reject(new Error("migration work failed")),
              verify: () => Promise.resolve(),
            },
          ],
          lockToken,
        ).catch((caught: unknown) => caught);

        // The original failure propagates, not an AggregateError.
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe("migration work failed");
        // The migration that finished before the failure was recorded.
        const recorded = await getDb().execute({
          args: ["runner-progress-recorded"],
          sql: `SELECT id FROM ${SCHEMA_MIGRATIONS_TABLE} WHERE id = ?`,
        });
        expect(recorded.rows.map((row) => String(row.id))).toEqual([
          "runner-progress-recorded",
        ]);
      } finally {
        await getDb().execute({
          args: ["runner-progress-recorded"],
          sql: `DELETE FROM ${SCHEMA_MIGRATIONS_TABLE} WHERE id = ?`,
        });
        await releaseMigrationLock(lockToken);
      }
    });

    test("stale markers are restored once the schema checks out", async () => {
      await staleSchemaHash();

      await restoreStaleSchemaMarkers();

      expect(await settingsValueOrNull(DB_SCHEMA_HASH_KEY)).toBe(SCHEMA_HASH);
      expect(debugLines()).toContain(
        "[Migration] Schema verified; restoring stale schema markers",
      );
    });

    test("stale markers are left alone when the schema does not match", async () => {
      await staleSchemaHash();
      await breakLiveSchema();
      try {
        await expect(restoreStaleSchemaMarkers()).rejects.toThrow(
          /Database schema markers are stale, no named migrations are pending.*must ship with a new entry in MIGRATIONS/s,
        );
        expect(await settingsValueOrNull(DB_SCHEMA_HASH_KEY)).toBe("stale");
      } finally {
        await syncIndexes();
        await restoreStaleSchemaMarkers();
      }
    });
  },
);
