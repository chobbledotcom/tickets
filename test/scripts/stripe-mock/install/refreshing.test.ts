import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import {
  downloadStripeMock,
  installLockPath,
} from "#scripts/stripe-mock/install.ts";
import {
  createFakeArchive,
  wait,
  withFakeCurl,
  withTempStripeMockPaths,
} from "#test/test-utils/stripe-mock/helpers.ts";

/** How long the install is made to take, so the lock is held for a while. */
const INSTALL_TAKES_MS = 120;
const TOUCH_EVERY_MS = 20;

type Touches = { afterFinishing: number; whileInstalling: number };

/**
 * Run an install that takes its time, counting how often the lock is written
 * to while it runs and how often it is written to afterwards.
 */
const touchesAround = async (touchMs: number): Promise<Touches> => {
  const fakeArchive = await createFakeArchive();
  const counts: Touches = { afterFinishing: 0, whileInstalling: 0 };
  let finished = false;
  try {
    await withTempStripeMockPaths(async (paths) => {
      const lockPath = installLockPath(paths);
      const writeTextFile = Deno.writeTextFile;
      using _write = stub(Deno, "writeTextFile", ((
        path: string | URL,
        data: string | ReadableStream<string>,
        options?: Deno.WriteFileOptions,
      ) => {
        if (String(path) === lockPath) {
          if (finished) counts.afterFinishing += 1;
          else counts.whileInstalling += 1;
        }
        return writeTextFile(path, data, options);
      }) as typeof Deno.writeTextFile);

      await withFakeCurl(
        `sleep ${INSTALL_TAKES_MS / 1000}; cat ${JSON.stringify(fakeArchive.archivePath)}`,
        async (curl) => {
          await downloadStripeMock({
            commands: { curl },
            installLockTouchMs: touchMs,
            paths,
          });
        },
      );
      finished = true;

      // Long enough for several more refreshes, if any were still coming.
      await wait(INSTALL_TAKES_MS);
    });
  } finally {
    await fakeArchive.cleanup();
  }
  return counts;
};

describe("keeping hold of the install lock", () => {
  test("keeps saying the lock is in use while the install runs", async () => {
    const touches = await touchesAround(TOUCH_EVERY_MS);

    // Written once to claim it, then again every so often. Without the
    // repeats, another install would think this one had died.
    expect(touches.whileInstalling).toBeGreaterThan(2);
  });

  test("stops saying so once the install is done", async () => {
    const touches = await touchesAround(TOUCH_EVERY_MS);

    expect(touches.afterFinishing).toBe(0);
  });
});
