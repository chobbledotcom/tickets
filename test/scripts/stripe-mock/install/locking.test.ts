import { join } from "node:path";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { installLockPath } from "#scripts/stripe-mock/install.ts";
import {
  createFakeArchive,
  expectStartFails,
  expectStripeMockFails,
  wait,
  waitForFile,
  waitForNoInstallTempDir,
  withFakeCurl,
  withInstallLockHeld,
  withInstallLockOpenFailure,
  withInstallLockWriteFailure,
  withLockRemovedDuringRead,
  withSecondLockRefreshHeld,
  withTempStripeMockPaths,
} from "#test/test-utils/stripe-mock/helpers.ts";
import { tempDir } from "#test-utils/files.ts";
import {
  expectDownloadWithLockCleanup,
  expectStaleLockRemoved,
  withBinaryReleasedAfterDelay,
} from "./lock-fixture.ts";

describe("stripe-mock install", () => {
  test("downloads a missing binary before trying to start it", async () => {
    using gate = tempDir();
    const fakeArchive = await createFakeArchive();
    // A gate around the fake download: curl signals `readyPath` once it is
    // running (so the install's temp dir provably exists) and then blocks until
    // the test creates `goPath`. Holding the download open like this lets the
    // test release the lock-refresh write only after the refresh has stopped,
    // so `scheduleNextRefresh` runs with `stopped` already true — deterministically.
    const readyPath = join(gate.path, "curl-ready");
    const goPath = join(gate.path, "curl-go");

    try {
      await withTempStripeMockPaths(async (paths) => {
        await withSecondLockRefreshHeld(
          installLockPath(paths),
          async (lockWrite) => {
            await withFakeCurl(
              [
                'if [ "$1" != "--fail" ]; then',
                '  echo "missing --fail" >&2',
                "  exit 7",
                "fi",
                `: > ${JSON.stringify(readyPath)}`,
                `while [ ! -e ${JSON.stringify(goPath)} ]; do sleep 0.01; done`,
                `cat ${JSON.stringify(fakeArchive.archivePath)}`,
              ].join("\n"),
              async (curl) => {
                const started = expectStripeMockFails({
                  budgetMs: 30,
                  commands: { curl },
                  delayMs: 10,
                  installLockTouchMs: 1,
                  paths,
                });
                // Hold the lock-refresh write, then wait for curl to be running
                // (its temp dir now exists) before letting the download finish.
                await lockWrite.waitForWrite();
                await waitForFile(readyPath);
                await Deno.writeTextFile(goPath, "");
                // Right after the gate opens the binary does not exist yet (the
                // download is only just starting) while the temp dir still does,
                // so these two waits deterministically exercise both the file
                // wait's retry loop and the temp-dir poll's "found" branch. They
                // resolve once the install finishes and cleans up — by which
                // point the refresh has been stopped.
                await Promise.all([
                  waitForFile(paths.binaryPath),
                  waitForNoInstallTempDir(paths.binDir),
                ]);
                await wait(1);
                // Releasing now runs `scheduleNextRefresh` with `stopped` true.
                lockWrite.releaseWrite();
                await started;
              },
            );
          },
        );

        const stat = await Deno.stat(paths.binaryPath);
        expect(stat.isFile).toBe(true);
        expect((stat.mode ?? 0) & 0o100).toBe(0o100);
      });
    } finally {
      await fakeArchive.cleanup();
    }
  });

  test("throws when the download command fails", async () => {
    await withTempStripeMockPaths(async (paths) => {
      await withFakeCurl("exit 7", async (curl) => {
        await expectStartFails({ commands: { curl }, paths });
      });
    });
  });

  test("surfaces download stderr when curl fails", async () => {
    await withTempStripeMockPaths(async (paths) => {
      await withFakeCurl('echo "HTTP 404" >&2; exit 22', async (curl) => {
        await expectStartFails(
          { commands: { curl }, paths },
          "Failed to download stripe-mock: HTTP 404",
        );
      });
    });
  });

  test("throws when the install lock cannot be created", async () => {
    await withTempStripeMockPaths(async (paths) => {
      await withInstallLockOpenFailure(paths, async () => {
        await expectStartFails({ paths }, "install lock create failed");
      });
    });
  });

  test("closes the install lock when writing its timestamp fails", async () => {
    await withTempStripeMockPaths(async (paths) => {
      await withInstallLockWriteFailure(paths, async (lock) => {
        await expectStartFails({ paths }, "install lock write failed");
        expect(lock.isClosed()).toBe(true);
      });
    });
  });

  test("waits for another install before using the binary", async () => {
    await withTempStripeMockPaths(async (paths) => {
      await withInstallLockHeld(paths, async (releaseLock) => {
        await withBinaryReleasedAfterDelay(paths, releaseLock, async () => {
          await expectStripeMockFails({
            budgetMs: 30,
            delayMs: 10,
            installLockRetryMs: 5,
            installLockTimeoutMs: 5_000,
            paths,
          });
        });
      });
    });
  });

  test("times out when the install lock never clears", async () => {
    await withTempStripeMockPaths(async (paths) => {
      await withInstallLockHeld(paths, async () => {
        await expectStartFails(
          {
            installLockRetryMs: 1,
            // Long enough that giving up means the time waited was really
            // measured, rather than any reading of the clock being past it.
            installLockTimeoutMs: 100,
            paths,
          },
          "Timed out waiting for stripe-mock install lock",
        );
      });
    });
  });

  test("waits when a fresh empty install lock has not been written yet", async () => {
    await withTempStripeMockPaths(async (paths) => {
      await withInstallLockHeld(
        paths,
        async (releaseLock) => {
          await withBinaryReleasedAfterDelay(paths, releaseLock, async () => {
            await withFakeCurl("exit 7", async (curl) => {
              await expectStripeMockFails({
                budgetMs: 30,
                commands: { curl },
                delayMs: 10,
                installLockRetryMs: 5,
                installLockStaleMs: 500,
                installLockTimeoutMs: 5_000,
                paths,
              });
            });
          });
        },
        false,
      );
    });
  });

  test("removes a stale install lock before downloading", async () => {
    await expectStaleLockRemoved(String(Date.now() - 1_000));
  });

  test("removes an empty stale install lock before downloading", async () => {
    await expectStaleLockRemoved("");
  });

  test("removes stale install temp directories before downloading", async () => {
    const fakeArchive = await createFakeArchive();

    try {
      await withTempStripeMockPaths(async (paths) => {
        const staleDir = join(paths.binDir, "stripe-mock-old");
        const keptDir = join(paths.binDir, "stripe-cache");
        const keptFile = join(paths.binDir, "stripe-mock-file");
        await Deno.mkdir(staleDir);
        await Deno.writeTextFile(join(staleDir, "old"), "old");
        await Deno.mkdir(keptDir);
        await Deno.writeTextFile(keptFile, "old");

        await withFakeCurl(
          `cat ${JSON.stringify(fakeArchive.archivePath)}`,
          (curl) => expectDownloadWithLockCleanup(paths, curl),
        );

        await expect(Deno.stat(staleDir)).rejects.toThrow();
        expect((await Deno.stat(keptDir)).isDirectory).toBe(true);
        expect((await Deno.stat(keptFile)).isFile).toBe(true);
      });
    } finally {
      await fakeArchive.cleanup();
    }
  });

  test("retries when the install lock disappears during the stale check", async () => {
    const fakeArchive = await createFakeArchive();

    try {
      await withTempStripeMockPaths(async (paths) => {
        const lockPath = installLockPath(paths);
        await Deno.writeTextFile(lockPath, String(Date.now()));
        await withLockRemovedDuringRead(lockPath, async () => {
          await withFakeCurl(
            `cat ${JSON.stringify(fakeArchive.archivePath)}`,
            async (curl) => {
              await expectStripeMockFails({
                budgetMs: 30,
                commands: { curl },
                delayMs: 10,
                installLockRetryMs: 1,
                // No time to try again: a lock that vanished counts as gone
                // straight away, or this install never gets to run.
                installLockTimeoutMs: 0,
                paths,
              });
            },
          );
        });

        expect((await Deno.stat(paths.binaryPath)).isFile).toBe(true);
      });
    } finally {
      await fakeArchive.cleanup();
    }
  });
});
