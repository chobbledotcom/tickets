import { join } from "node:path";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { relativeToProject } from "#scripts/path.ts";
import {
  defaultStripeMockPaths,
  downloadStripeMock,
  installLockPath,
} from "#scripts/stripe-mock/install.ts";
import {
  createFakeArchive,
  expectStartFails,
  expectStripeMockFails,
  makeExecutable,
  type TestStripeMockPaths,
  wait,
  waitForFile,
  waitForNoInstallTempDir,
  withFakeCurl,
  withInstallLockHeld,
  withInstallLockOpenFailure,
  withInstallLockRemoveFailure,
  withInstallLockWriteFailure,
  withLockReadFailure,
  withLockRemovedDuringRead,
  withSecondLockRefreshHeld,
  withTempStripeMockPaths,
} from "#test/test-utils/stripe-mock/helpers.ts";
import { tempDir } from "#test-utils/files.ts";

const oldDate = (): Date => new Date(Date.now() - 1_000);

const makeLockFileOld = async (lockPath: string): Promise<void> => {
  const date = oldDate();
  await Deno.utime(lockPath, date, date);
};

const expectStaleLockRemoved = async (lockText: string): Promise<void> => {
  const fakeArchive = await createFakeArchive();

  try {
    await withTempStripeMockPaths(async (paths) => {
      const lockPath = installLockPath(paths);
      await Deno.writeTextFile(lockPath, lockText);
      await makeLockFileOld(lockPath);
      await withFakeCurl(
        `cat ${JSON.stringify(fakeArchive.archivePath)}`,
        async (curl) => {
          await expectStripeMockFails({
            budgetMs: 30,
            commands: { curl },
            delayMs: 10,
            installLockRetryMs: 1,
            installLockStaleMs: 1,
            paths,
          });
        },
      );

      await expect(Deno.stat(lockPath)).rejects.toThrow();
      expect((await Deno.stat(paths.binaryPath)).isFile).toBe(true);
    });
  } finally {
    await fakeArchive.cleanup();
  }
};

const releaseLockAfterWritingBinary = async (
  paths: TestStripeMockPaths,
  releaseLock: () => Promise<void>,
): Promise<void> => {
  const pendingBinaryPath = `${paths.binaryPath}.pending`;
  await wait(30);
  await Deno.writeTextFile(pendingBinaryPath, "#!/bin/sh\nexit 0\n");
  await makeExecutable(pendingBinaryPath);
  await Deno.rename(pendingBinaryPath, paths.binaryPath);
  await releaseLock();
};

const withBinaryReleasedAfterDelay = async (
  paths: TestStripeMockPaths,
  releaseLock: () => Promise<void>,
  body: (releaseLock: () => Promise<void>) => Promise<void>,
): Promise<void> => {
  const releasing = releaseLockAfterWritingBinary(paths, releaseLock);

  try {
    await body(releaseLock);
  } finally {
    await releasing;
  }
};

const expectDownloadWithLockCleanup = async (
  paths: TestStripeMockPaths,
  curl: string,
): Promise<void> => {
  await expectStripeMockFails({
    budgetMs: 30,
    commands: { curl },
    delayMs: 10,
    paths,
  });
};

/** What stripe-mock calls the machine this test is running on. */
const expectedPlatform = (): string =>
  Deno.build.os === "darwin" ? "darwin" : "linux";

const expectedArch = (): string =>
  Deno.build.arch === "aarch64" ? "arm64" : "amd64";

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
            installLockTimeoutMs: 1,
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

describe("what stripe-mock is fetched with", () => {
  test("asks curl for the pinned release for this machine, quietly", async () => {
    const fakeArchive = await createFakeArchive();
    try {
      await withTempStripeMockPaths(async (paths) => {
        const argsPath = join(paths.binDir, "curl-args");
        await withFakeCurl(
          `printf '%s\n' "$@" > ${JSON.stringify(argsPath)}; cat ${JSON.stringify(
            fakeArchive.archivePath,
          )}`,
          async (curl) => {
            await downloadStripeMock({ commands: { curl }, paths });
          },
        );

        const args = (await Deno.readTextFile(argsPath)).trim().split("\n");
        const url = args.find((arg) => arg.startsWith("https://"));

        // Quiet, following redirects, and writing the archive to our own hands.
        expect(args).toContain("-sL");
        expect(args).toContain("-o");
        expect(args).toContain("-");
        // The version is pinned on purpose. Changing it here means changing
        // it in install.ts and in the note about it in AGENTS.md.
        const version = "0.188.0";
        expect(url).toBe(
          `https://github.com/stripe/stripe-mock/releases/download/v${version}/stripe-mock_${version}_${expectedPlatform()}_${expectedArch()}.tar.gz`,
        );
      });
    } finally {
      await fakeArchive.cleanup();
    }
  });

  test("keeps the binary in the project's own bin folder", () => {
    expect(relativeToProject(defaultStripeMockPaths.binDir)).toBe(".bin");
    expect(relativeToProject(defaultStripeMockPaths.binaryPath)).toBe(
      ".bin/stripe-mock",
    );
  });
});

describe("when a step of the install goes wrong", () => {
  test("says which step failed when the archive cannot be opened", async () => {
    await withTempStripeMockPaths(async (paths) => {
      await withFakeCurl("echo not-an-archive", async (curl) => {
        await expect(
          downloadStripeMock({ commands: { curl, tar: "false" }, paths }),
        ).rejects.toThrow("Failed to extract stripe-mock");
      });
    });
  });

  test("says which step failed when the binary cannot be made runnable", async () => {
    const fakeArchive = await createFakeArchive();
    try {
      await withTempStripeMockPaths(async (paths) => {
        await withFakeCurl(
          `cat ${JSON.stringify(fakeArchive.archivePath)}`,
          async (curl) => {
            await expect(
              downloadStripeMock({
                commands: { chmod: "false", curl },
                paths,
              }),
            ).rejects.toThrow("Failed to make stripe-mock executable");
          },
        );
      });
    } finally {
      await fakeArchive.cleanup();
    }
  });

  test("makes the bin folder before reaching for the lock in it", async () => {
    const fakeArchive = await createFakeArchive();
    try {
      const parent = await Deno.makeTempDir();
      // Nothing has made this folder yet, so the lock has nowhere to live.
      const paths = {
        binaryPath: join(parent, "bin", "stripe-mock"),
        binDir: join(parent, "bin"),
      };
      try {
        await withFakeCurl(
          `cat ${JSON.stringify(fakeArchive.archivePath)}`,
          async (curl) => {
            await downloadStripeMock({ commands: { curl }, paths });
          },
        );

        expect((await Deno.stat(paths.binaryPath)).isFile).toBe(true);
      } finally {
        await Deno.remove(parent, { recursive: true });
      }
    } finally {
      await fakeArchive.cleanup();
    }
  });
});
