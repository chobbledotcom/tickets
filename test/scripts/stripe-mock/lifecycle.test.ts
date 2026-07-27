import { join } from "node:path";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  STRIPE_MOCK_FAILED_TO_START,
  startStripeMock,
} from "#scripts/stripe-mock.ts";
import type { StartOptions } from "#test/test-utils/stripe-mock/helpers.ts";
import {
  expectPortAvailable,
  expectPortOpen,
  expectStripeMockFails,
  freePort,
  runsToCompletion,
  startCount,
  startFailureMessage,
  testEnv,
  withFakeCurl,
  withHeldPort,
  withTempStripeMockPaths,
  withUnusedPort,
  writeCountingFailingMock,
  writeDiesWhileConfirmingMock,
  writeFailingMock,
  writeSlowToListenMock,
  writeSlowToStopMock,
  writeWrongPortMock,
} from "#test/test-utils/stripe-mock/helpers.ts";
import { pathExists } from "#test-utils/files.ts";

const START_LOCK_NAME = "stripe-mock.start.lock";

/**
 * Ask for three tries at a mock that always fails, with the port settled the
 * given way, and report how many times it was actually started.
 */
const triesBeforeGivingUp = async (
  pinPort: (port: number) => StartOptions,
): Promise<number> => {
  let tries = 0;
  await withTempStripeMockPaths(async (paths) => {
    const count = join(paths.binDir, "starts");
    await writeCountingFailingMock(paths, count, "no good");

    await withUnusedPort(async (port) => {
      await expect(
        startStripeMock({
          budgetMs: 50,
          delayMs: 1,
          paths,
          startAttempts: 3,
          ...pinPort(port),
        }),
      ).rejects.toThrow(STRIPE_MOCK_FAILED_TO_START);
    });

    tries = await startCount(count);
  });
  return tries;
};

describe("starting stripe-mock", () => {
  test("does not call a mock ready when it dies while being checked", async () => {
    await withTempStripeMockPaths(async (paths) => {
      // Opens its port, then dies — the standard settling wait must notice.
      await writeDiesWhileConfirmingMock(paths);

      await expectStripeMockFails({ budgetMs: 500, delayMs: 10, paths });
    });
  });

  test("waits for a mock that takes its time to open its port", async () => {
    await withTempStripeMockPaths(async (paths) => {
      // The standard poll allows ten seconds, so a slow start is fine.
      await writeSlowToListenMock(paths);

      await withUnusedPort(async (port) => {
        const stripeMock = await startStripeMock({ paths, port });

        try {
          await expectPortOpen(port);
        } finally {
          await stripeMock.stop();
        }
      });
    });
  });

  test("gives a mock time to shut itself down before killing it", async () => {
    await withTempStripeMockPaths(async (paths) => {
      const note = join(paths.binDir, "stopped-cleanly");
      await writeSlowToStopMock(paths, note);

      await withUnusedPort(async (port) => {
        const stripeMock = await startStripeMock({
          budgetMs: 1000,
          delayMs: 10,
          paths,
          port,
        });
        await expectPortOpen(port);

        await stripeMock.stop();

        expect(await pathExists(note)).toBe(true);
      });
    });
  });

  test("stops trying once the mock has been started as many times as asked", async () => {
    // Nobody pinned the port, so a fresh one is worth trying.
    expect(await triesBeforeGivingUp(() => ({ env: testEnv({}) }))).toBe(3);
  });

  test("tries a pinned port only once, however many tries were asked for", async () => {
    expect(await triesBeforeGivingUp((port) => ({ port }))).toBe(1);
  });

  test("treats a port named in the environment as pinned too", async () => {
    expect(
      await triesBeforeGivingUp((port) => ({
        env: testEnv({ STRIPE_MOCK_PORT: String(port) }),
      })),
    ).toBe(1);
  });

  test("says what went wrong, once, however many tries it took", async () => {
    await withTempStripeMockPaths(async (paths) => {
      await writeFailingMock(paths, "wrong binary");

      const message = await startFailureMessage({
        budgetMs: 50,
        delayMs: 1,
        env: testEnv({}),
        paths,
        startAttempts: 3,
      });

      // Every try says the same thing; the reader only needs to hear it once.
      expect(message).toBe("stripe-mock failed to start: wrong binary");
    });
  });

  test("says only that it failed when no try explained itself", async () => {
    await withHeldPort(async (port) => {
      const message = await startFailureMessage({
        choosePort: () => port,
        env: testEnv({}),
        startAttempts: 2,
      });

      // Somebody else holds the port, so no mock of ours ever printed anything.
      expect(message).toBe("stripe-mock failed to start");
    });
  });

  test("polls again after waiting when the port is not open yet", async () => {
    await withTempStripeMockPaths(async (paths) => {
      // Listens soon, but never on the very first look.
      await writeSlowToListenMock(paths, 60);

      await withUnusedPort(async (port) => {
        const stripeMock = await startStripeMock({
          budgetMs: 5000,
          delayMs: 300,
          paths,
          port,
        });

        try {
          await expectPortOpen(port);
        } finally {
          await stripeMock.stop();
        }
      });
    });
  });

  test("gives up as soon as the mock dies, without waiting out the poll", async () => {
    await withTempStripeMockPaths(async (paths) => {
      await writeFailingMock(paths, "wrong binary");

      await withUnusedPort(async (port) => {
        // A poll this patient would take half a minute to run out. Noticing the
        // mock has died is what keeps the failure quick.
        await expectStripeMockFails({
          budgetMs: 30_000,
          delayMs: 200,
          paths,
          port,
        });
      });
    });
  });

  test("stops a mock that never opened the port it was given", async () => {
    await withTempStripeMockPaths(async (paths) => {
      await withUnusedPort(async (decoyPort) => {
        await writeWrongPortMock(paths, decoyPort);

        await withUnusedPort(async (port) => {
          await expectStripeMockFails({
            budgetMs: 100,
            delayMs: 10,
            paths,
            port,
          });
        });

        // Left running, it would still be sitting on the port it did open.
        expectPortAvailable(decoyPort);
      });
    });
  });

  test("fetches the binary before picking a port of its own", async () => {
    await withTempStripeMockPaths(async (paths) => {
      await withFakeCurl("echo 'no network' >&2; exit 1", async (curl) => {
        const message = await startFailureMessage({
          commands: { curl },
          env: testEnv({}),
          paths,
          startAttempts: 1,
        });

        // Without the fetch it would fail later, on a binary that is not there.
        expect(message).toContain("no network");
      });
    });
  });

  test("lets the process that started it exit without stopping it first", async () => {
    await withTempStripeMockPaths(async (paths) => {
      await writeSlowToListenMock(paths, 0);

      const finished = await runsToCompletion(`
        import { startStripeMock } from "#scripts/stripe-mock.ts";
        await startStripeMock({
          budgetMs: 1000,
          delayMs: 10,
          paths: ${JSON.stringify(paths)},
          port: ${await freePort()},
        });
      `);

      // A mock still counted as work to wait for would hold this open forever.
      expect(finished).toBe(true);
    });
  });

  test("takes the shared start lock only when it picked the port itself", async () => {
    await withTempStripeMockPaths(async (paths) => {
      await writeSlowToListenMock(paths, 0);
      const lock = join(paths.binDir, START_LOCK_NAME);

      await withUnusedPort(async (port) => {
        const pinned = await startStripeMock({
          budgetMs: 1000,
          delayMs: 10,
          paths,
          port,
        });
        await pinned.stop();
      });

      // Nobody else can be racing for a port that was named for us.
      expect(await pathExists(lock)).toBe(false);

      const chosen = await startStripeMock({
        budgetMs: 1000,
        delayMs: 10,
        env: testEnv({}),
        paths,
      });
      await chosen.stop();

      expect(await pathExists(lock)).toBe(true);
    });
  });
});
