/**
 * Shared setup for the install-lock suites: ageing a lock file, standing in for
 * another install that finishes partway through, and the common expectations.
 */

import { expect } from "@std/expect";
import { installLockPath } from "#scripts/stripe-mock/install.ts";
import {
  createFakeArchive,
  makeExecutable,
  type TestStripeMockPaths,
  wait,
  withFakeCurl,
  withTempStripeMockPaths,
} from "#test/test-utils/stripe-mock/helpers.ts";
import { expectStripeMockFails } from "#test/test-utils/stripe-mock/ports.ts";

const oldDate = (): Date => new Date(Date.now() - 1_000);

const makeLockFileOld = async (lockPath: string): Promise<void> => {
  const date = oldDate();
  await Deno.utime(lockPath, date, date);
};

export const expectStaleLockRemoved = async (
  lockText: string,
): Promise<void> => {
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

export const withBinaryReleasedAfterDelay = async (
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

export const expectDownloadWithLockCleanup = async (
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
