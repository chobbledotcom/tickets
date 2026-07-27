import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import {
  downloadStripeMock,
  installLockPath,
} from "#scripts/stripe-mock/install.ts";
import {
  createFakeArchive,
  type TestStripeMockPaths,
  wait,
  withFakeCurl,
  withInstallLockHeld,
  withTempStripeMockPaths,
} from "#test/test-utils/stripe-mock/helpers.ts";

/** How long the other install keeps hold of the lock before letting go. */
const HELD_FOR_MS = 250;

type Tries = { count: number };

/**
 * Run an install while somebody else holds the lock for a moment, and report
 * how many times ours tried to take it before it got in.
 */
const triesWhileWaiting = async (
  body: (context: {
    paths: TestStripeMockPaths;
    tries: Tries;
  }) => Promise<void>,
): Promise<void> => {
  const fakeArchive = await createFakeArchive();
  try {
    await withTempStripeMockPaths(async (paths) => {
      const lockPath = installLockPath(paths);
      const tries: Tries = { count: 0 };
      const open = Deno.open;
      using _open = stub(Deno, "open", ((
        path: string | URL,
        options?: Deno.OpenOptions,
      ) => {
        if (String(path) === lockPath && options?.createNew) tries.count += 1;
        return open(path, options);
      }) as typeof Deno.open);

      await withInstallLockHeld(paths, async (releaseLock) => {
        const letGo = wait(HELD_FOR_MS).then(releaseLock);
        await withFakeCurl(
          `cat ${JSON.stringify(fakeArchive.archivePath)}`,
          async (curl) => {
            await downloadStripeMock({ commands: { curl }, paths });
          },
        );
        await letGo;
      });

      await body({ paths, tries });
    });
  } finally {
    await fakeArchive.cleanup();
  }
};

describe("waiting for another install to finish", () => {
  test("waits for the lock rather than giving up at once", async () => {
    await triesWhileWaiting(async ({ paths }) => {
      // Getting the binary at all means it outlasted the other install.
      expect((await Deno.stat(paths.binaryPath)).isFile).toBe(true);
    });
  });

  test("pauses between tries instead of asking as fast as it can", async () => {
    await triesWhileWaiting(({ tries }) => {
      // A quarter of a second of waiting, fifty milliseconds apart, is a
      // handful of tries. With no pause it would be many thousands.
      expect(tries.count).toBeLessThan(50);
      return Promise.resolve();
    });
  });

  test("leaves a lock that is still being looked after alone", async () => {
    await triesWhileWaiting(({ tries }) => {
      // It never treated the other install's fresh lock as abandoned, so it
      // had to try more than once.
      expect(tries.count).toBeGreaterThan(1);
      return Promise.resolve();
    });
  });
});
