import { join } from "node:path";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  STRIPE_MOCK_FAILED_TO_START,
  startStripeMock,
} from "#scripts/stripe-mock.ts";
import { pathExists } from "#test-utils/files.ts";
import {
  type StartOptions,
  testEnv,
  withFakeCurl,
  withTempStripeMockPaths,
  writeFailingMock,
} from "#test-utils/stripe-mock/helpers.ts";
import {
  expectPortAvailable,
  expectPortOpen,
  expectStripeMockFails,
  retryWhilePortTaken,
  withHeldPort,
  withUnusedPort,
} from "#test-utils/stripe-mock/ports.ts";
import {
  freePort,
  runsToCompletion,
  startCount,
  startFailureMessage,
  withCountedLooks,
  writeCountingFailingMock,
  writeDiesWhileConfirmingMock,
  writeShortLivedMock,
  writeSlowToListenMock,
  writeSlowToStopMock,
  writeWrongPortMock,
} from "./fixtures.ts";

const START_LOCK_NAME = "stripe-mock.start.lock";

/**
 * Ask for three tries at a mock that always fails, with the port settled the
 * given way, and report how many times it was actually started.
 *
 * The port is picked and let go of before the start uses it, so another test
 * can take it in between. A start that finds the port already listening
 * returns without spawning — the only way an attempt skips its spawn — so a
 * stolen port shows up as a count below `wanted`. Ask again on a fresh port
 * rather than reading someone else's port as this test's answer.
 */
const triesBeforeGivingUp = async (
  pinPort: (port: number) => StartOptions,
  wanted: number,
): Promise<number> => {
  let tries = 0;
  await retryWhilePortTaken(
    async () => {
      await withTempStripeMockPaths(async (paths) => {
        const count = join(paths.binDir, "starts");
        await writeCountingFailingMock(paths, count, "no good");

        await withUnusedPort(async (port) => {
          await expect(
            startStripeMock({
              budgetMs: 50,
              choosePort: () => port,
              delayMs: 1,
              paths,
              startAttempts: 3,
              ...pinPort(port),
            }),
          ).rejects.toThrow(STRIPE_MOCK_FAILED_TO_START);
        });

        tries = await startCount(count);
      });
      return tries < wanted;
    },
    () => `The mock started ${tries} times instead of ${wanted}`,
  );
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
      // Starts our mock on the port, or null when the start reports failure —
      // our mock lost the port to another test between picking and binding
      // it, so it died without ever listening. Any other error still throws.
      const startOnPortOrNull = async (port: number) => {
        try {
          return await startStripeMock({
            budgetMs: 1000,
            delayMs: 10,
            paths,
            port,
            // Far longer than the mock's shutdown, so a busy machine cannot
            // make this read as an impatient stopper. A CI runner under two
            // parallel suite runs has starved the mock past 10 seconds, so
            // the allowance is generous — a healthy stop returns on exit,
            // never on this timer.
            stopTimeoutMs: 60_000,
          });
        } catch (error) {
          if (!String(error).includes(STRIPE_MOCK_FAILED_TO_START)) {
            throw error;
          }
          return null;
        }
      };

      let round = 0;
      await retryWhilePortTaken(async () => {
        // Fresh notes each round, so a leftover from an earlier stolen-port
        // round can never speak for this one.
        round += 1;
        const note = join(paths.binDir, `stopped-cleanly-${round}`);
        const bound = join(paths.binDir, `bound-${round}`);
        await writeSlowToStopMock(paths, note, bound);

        let portWasTaken = false;
        await withUnusedPort(async (port) => {
          const stripeMock = await startOnPortOrNull(port);
          // No bound note means our mock never got the port: the start found
          // something else already listening and adopted it. Ask again.
          if (stripeMock === null || !(await pathExists(bound))) {
            await stripeMock?.stop();
            portWasTaken = true;
            return;
          }
          await expectPortOpen(port);

          await stripeMock.stop();

          expect(await pathExists(note)).toBe(true);
        });
        return portWasTaken;
      });
    });
  });

  test("stops trying once the mock has been started as many times as asked", async () => {
    // Nobody pinned the port, so a fresh one is worth trying.
    expect(await triesBeforeGivingUp(() => ({ env: testEnv({}) }), 3)).toBe(3);
  });

  test("tries a pinned port only once, however many tries were asked for", async () => {
    expect(await triesBeforeGivingUp((port) => ({ port }), 1)).toBe(1);
  });

  test("treats a port named in the environment as pinned too", async () => {
    expect(
      await triesBeforeGivingUp(
        (port) => ({ env: testEnv({ STRIPE_MOCK_PORT: String(port) }) }),
        1,
      ),
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

  test("looks again after waiting when the port is not open yet", async () => {
    await withTempStripeMockPaths(async (paths) => {
      await writeSlowToListenMock(paths, 0);

      await withUnusedPort(async (port) => {
        // The first look after starting the mock is refused, however quickly it
        // really opened, so reaching the port at all means looking twice.
        await withCountedLooks(
          (look) => look === 2,
          async (looks) => {
            const stripeMock = await startStripeMock({
              budgetMs: 5000,
              delayMs: 10,
              paths,
              port,
            });

            try {
              expect(looks.count).toBeGreaterThanOrEqual(3);
            } finally {
              await stripeMock.stop();
            }
          },
        );
      });
    });
  });

  test("waits between looks instead of asking as fast as it can", async () => {
    await withTempStripeMockPaths(async (paths) => {
      await writeShortLivedMock(paths);

      await withUnusedPort(async (port) => {
        // Nothing ever answers, so the starter looks until its time is up.
        await withCountedLooks(
          () => true,
          async (looks) => {
            await expect(
              startStripeMock({ budgetMs: 300, paths, port }),
            ).rejects.toThrow(STRIPE_MOCK_FAILED_TO_START);

            // Three hundred milliseconds of looking, ten milliseconds apart, is
            // tens of looks. Without the wait it would be many thousands.
            expect(looks.count).toBeLessThan(200);
          },
        );
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
      // Serves its port for a while and then stops itself, so walking away from
      // it here does not leave a listener behind for the rest of the machine.
      await writeShortLivedMock(paths, 20);

      const finished = await runsToCompletion(
        `
        import { startStripeMock } from "#scripts/stripe-mock.ts";
        await startStripeMock({
          budgetMs: 1000,
          delayMs: 10,
          paths: ${JSON.stringify(paths)},
          port: ${await freePort()},
        });
      `,
        10_000,
      );

      // A mock still counted as work to wait for would hold this open until the
      // mock stopped by itself, which is long after the deadline above.
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
