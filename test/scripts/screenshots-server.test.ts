import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import {
  startOnFirstUse,
  startWithFailureCleanup,
  waitForHealthy,
} from "#scripts/screenshots/server.ts";
import { requireValue } from "#shared/required-value.ts";

const expectOneRetry = async (
  request: () => Promise<Response>,
): Promise<void> => {
  let waits = 0;
  const healthy = await waitForHealthy(
    request,
    () => {
      waits += 1;
      return Promise.resolve();
    },
    () => true,
  );
  expect(healthy).toBe(true);
  expect(waits).toBe(1);
};

describe("screenshot server", () => {
  it("starts an optional resource only on first use", async () => {
    let starts = 0;
    let stops = 0;
    const cleanups: (() => void)[] = [];
    const start = startOnFirstUse(
      () => {
        starts += 1;
        return Promise.resolve({
          stop: () => {
            stops += 1;
          },
        });
      },
      (cleanup) => cleanups.push(cleanup),
    );

    expect(starts).toBe(0);
    await start();
    await start();
    expect(starts).toBe(1);
    expect(cleanups).toHaveLength(1);
    await requireValue(cleanups[0], "Missing optional resource cleanup.")();
    expect(stops).toBe(1);
  });

  it("stops an acquired resource when startup fails", async () => {
    const startupError = new Error("startup failed");
    const stops: string[] = [];

    await expect(
      startWithFailureCleanup(({ add }) => {
        add(() => {
          stops.push("first");
        });
        add(() => {
          stops.push("second");
        });
        return Promise.reject(startupError);
      }),
    ).rejects.toBe(startupError);
    expect(stops).toEqual(["second", "first"]);
  });

  it("hands cleanup ownership to a successful startup", async () => {
    let stops = 0;

    const stop = await startWithFailureCleanup(({ add, run }) => {
      add(() => {
        stops += 1;
      });
      return Promise.resolve(run);
    });
    expect(stops).toBe(0);
    await stop();
    expect(stops).toBe(1);
  });

  it("runs every cleanup when one fails", async () => {
    const cleanupError = new Error("cleanup failed");
    let finalCleanupRan = false;

    await expect(
      startWithFailureCleanup(({ add }) => {
        add(() => {
          finalCleanupRan = true;
        });
        add(() => Promise.reject(cleanupError));
        return Promise.reject(new Error("startup failed"));
      }),
    ).rejects.toEqual(
      new AggregateError(
        [new Error("startup failed"), cleanupError],
        "Multiple errors occurred",
      ),
    );
    expect(finalCleanupRan).toBe(true);
  });

  it("waits before retrying a non-OK response", async () => {
    const responses = [
      new Response("Starting", { status: 503 }),
      new Response(),
    ];
    await expectOneRetry(() => {
      const response = responses.shift();
      if (!response) throw new Error("No test response left.");
      return Promise.resolve(response);
    });
  });

  it("waits before retrying a fetch error", async () => {
    let attempts = 0;
    await expectOneRetry(() => {
      attempts += 1;
      return attempts === 1
        ? Promise.reject(new TypeError("not listening"))
        : Promise.resolve(new Response());
    });
  });

  it("reports when the deadline has passed", async () => {
    expect(
      await waitForHealthy(
        () => Promise.resolve(new Response()),
        () => Promise.resolve(),
        () => false,
      ),
    ).toBe(false);
  });
});
