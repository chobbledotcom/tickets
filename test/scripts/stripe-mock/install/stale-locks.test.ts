import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  downloadStripeMock,
  installLockPath,
} from "#scripts/stripe-mock/install.ts";
import {
  createFakeArchive,
  withFakeCurl,
  withTempStripeMockPaths,
} from "#test/test-utils/stripe-mock/helpers.ts";

/** Long ago, so any sane staleness rule counts it as abandoned. */
const LONG_AGO = new Date(Date.now() - 60 * 60 * 1000);

/**
 * Leave a lock behind with the given contents, then try to install. Gives back
 * whether the install got past it, without waiting long if it did not.
 */
const installsPast = async (
  lockText: string,
  age: Date = LONG_AGO,
): Promise<boolean> => {
  const fakeArchive = await createFakeArchive();
  let installed = false;
  try {
    await withTempStripeMockPaths(async (paths) => {
      const lockPath = installLockPath(paths);
      await Deno.writeTextFile(lockPath, lockText);
      await Deno.utime(lockPath, age, age);

      await withFakeCurl(
        `cat ${JSON.stringify(fakeArchive.archivePath)}`,
        async (curl) => {
          try {
            await downloadStripeMock({
              commands: { curl },
              installLockRetryMs: 1,
              // No time to try again, so an abandoned lock has to be taken
              // over on the very first look for this install to happen at all.
              installLockTimeoutMs: 0,
              paths,
            });
            installed = true;
          } catch {
            // Gave up waiting: the lock was treated as still in use.
            installed = false;
          }
        },
      );
    });
  } finally {
    await fakeArchive.cleanup();
  }
  return installed;
};

describe("a lock left behind by an install that never finished", () => {
  test("is taken over once it is old enough", async () => {
    expect(await installsPast(`someone-else\n${LONG_AGO.getTime()}`)).toBe(
      true,
    );
  });

  test("is taken over when it says a time from the very start of the clock", async () => {
    // The file itself was touched a moment ago, so only reading the time it
    // claims — 1970, however unlikely — can tell that it is abandoned.
    expect(await installsPast("someone-else\n1", new Date())).toBe(true);
  });

  test("is judged by the file's own age when it says no time at all", async () => {
    expect(await installsPast("someone-else\nnot-a-time")).toBe(true);
  });

  test("is judged by the file's own age when it is from an older install", async () => {
    // Older installs wrote the time alone, with nobody's name against it.
    expect(await installsPast(String(LONG_AGO.getTime()))).toBe(true);
  });

  test("is judged by the file's age when its time has nothing after it", async () => {
    // A time with a newline after it and nothing else is not a record we ever
    // write, so the file's own age decides — and this file is new.
    expect(await installsPast(`${LONG_AGO.getTime()}\n`, new Date())).toBe(
      false,
    );
  });

  test("is left alone while it is still fresh", async () => {
    expect(await installsPast(`someone-else\n${Date.now()}`, new Date())).toBe(
      false,
    );
  });
});
