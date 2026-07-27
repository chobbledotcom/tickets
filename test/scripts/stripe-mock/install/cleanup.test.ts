import { join } from "node:path";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { installLockPath } from "#scripts/stripe-mock/install.ts";
import {
  createFakeArchive,
  expectStartFails,
  withFakeCurl,
  withInstallLockRemoveFailure,
  withLockReadFailure,
  withSecondLockRefreshHeld,
  withTempStripeMockPaths,
} from "#test/test-utils/stripe-mock/helpers.ts";
import { expectDownloadWithLockCleanup } from "./lock-fixture.ts";

describe("cleaning up after an install", () => {
  test("ignores a missing install lock during cleanup", async () => {
    const fakeArchive = await createFakeArchive();

    try {
      await withTempStripeMockPaths(async (paths) => {
        const lockPath = installLockPath(paths);
        await withInstallLockRemoveFailure(
          lockPath,
          new Deno.errors.NotFound(),
          async () => {
            await withFakeCurl(
              `cat ${JSON.stringify(fakeArchive.archivePath)}`,
              (curl) => expectDownloadWithLockCleanup(paths, curl),
            );
          },
        );

        expect((await Deno.stat(paths.binaryPath)).isFile).toBe(true);
      });
    } finally {
      await fakeArchive.cleanup();
    }
  });

  test("throws when install lock cleanup fails", async () => {
    const fakeArchive = await createFakeArchive();

    try {
      await withTempStripeMockPaths(async (paths) => {
        const lockPath = installLockPath(paths);
        await withInstallLockRemoveFailure(
          lockPath,
          new Error("install lock cleanup failed"),
          async () => {
            await withFakeCurl(
              `cat ${JSON.stringify(fakeArchive.archivePath)}`,
              async (curl) => {
                await expectStartFails(
                  { commands: { curl }, paths },
                  "install lock cleanup failed",
                );
              },
            );
          },
        );
      });
    } finally {
      await fakeArchive.cleanup();
    }
  });

  test("keeps a replacement install lock during cleanup", async () => {
    await withTempStripeMockPaths(async (paths) => {
      const lockPath = installLockPath(paths);
      const replacementOwner = crypto.randomUUID();
      await withFakeCurl(
        [
          `cat > ${JSON.stringify(lockPath)} <<'EOF'`,
          replacementOwner,
          String(Date.now()),
          "EOF",
          "exit 7",
        ].join("\n"),
        async (curl) => {
          await expectStartFails(
            { commands: { curl }, paths },
            "Failed to download stripe-mock",
          );
        },
      );

      expect(await Deno.readTextFile(lockPath)).toContain(replacementOwner);
    });
  });

  test("throws when the install lock stale check fails", async () => {
    await withTempStripeMockPaths(async (paths) => {
      const lockPath = installLockPath(paths);
      await Deno.writeTextFile(lockPath, String(Date.now()));
      await withLockReadFailure(lockPath, async () => {
        await expectStartFails({ paths }, "stale check failed");
      });
    });
  });

  test("stops the lock refresh without scheduling another write when the install fails mid-refresh", async () => {
    // Regression: scheduleNextRefresh (line 157) checks `if (stopped) return;`
    // — the branch where a lock refresh write is still in-flight when the
    // install fails and stopRefreshingLock is called. Without coverage, a
    // mutation to that guard (e.g. `if (!stopped) return;`) would silently
    // schedule an extra refresh write after the lock is released.
    await withTempStripeMockPaths(async (paths) => {
      const proceedPath = join(paths.binDir, "proceed");
      await withSecondLockRefreshHeld(
        installLockPath(paths),
        async (lockWrite) => {
          await withFakeCurl(
            `while [ ! -f ${JSON.stringify(proceedPath)} ]; do sleep 0.01; done; exit 7`,
            async (curl) => {
              const started = expectStartFails(
                { commands: { curl }, installLockTouchMs: 1, paths },
                "Failed to download stripe-mock",
              );
              // Wait for the 3rd lock refresh write to be intercepted and
              // paused — at that point the install body is still running
              // (curl is spinning on the proceed file).
              await lockWrite.waitForWrite();
              // Let curl fail now — the install body throws and
              // stopRefreshingLock sets stopped=true while the 3rd write
              // is still in-flight.
              await Deno.writeTextFile(proceedPath, "");
              // Releasing the paused write lets scheduleNextRefresh run with
              // stopped=true — it returns early instead of scheduling another.
              lockWrite.releaseWrite();
              await started;
            },
          );
        },
      );
    });
  });
});
