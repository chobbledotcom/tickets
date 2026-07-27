import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  applyMigrationWithRetry,
  VERIFY_RETRY_BACKOFF_MS,
  verifyMigrationWithRetry,
} from "#shared/db/migrations/runner.ts";
import type { Migration } from "#shared/db/migrations/types.ts";
import { withVirtualBackoff } from "#test-utils/virtual-time.ts";

describe("db > migrations > runner", () => {
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

    test("rethrows after exhausting every retry", async () => {
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
      // One initial attempt plus one per backoff entry.
      expect(attempts).toBe(VERIFY_RETRY_BACKOFF_MS.length + 1);
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
