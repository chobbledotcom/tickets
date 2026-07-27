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
              installLockTimeoutMs: 200,
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
    // A time of 1 is a real time, however unlikely: 1970 is long ago enough.
    expect(await installsPast("someone-else\n1")).toBe(true);
  });

  test("is judged by the file's own age when it says no time at all", async () => {
    expect(await installsPast("someone-else\nnot-a-time")).toBe(true);
  });

  test("is judged by the file's own age when it is from an older install", async () => {
    // Older installs wrote the time alone, with nobody's name against it.
    expect(await installsPast(String(LONG_AGO.getTime()))).toBe(true);
  });

  test("is left alone while it is still fresh", async () => {
    expect(await installsPast(`someone-else\n${Date.now()}`, new Date())).toBe(
      false,
    );
  });
});
