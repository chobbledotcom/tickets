import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import {
  startWithFailureCleanup,
  waitForHealthy,
} from "../../scripts/screenshots/server.ts";

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
  it("stops an acquired resource when startup fails", async () => {
    const startupError = new Error("startup failed");
    let stops = 0;

    await expect(
      startWithFailureCleanup(
        () => Promise.reject(startupError),
        () => {
          stops += 1;
        },
      ),
    ).rejects.toBe(startupError);
    expect(stops).toBe(1);
  });

  it("leaves an acquired resource running after successful startup", async () => {
    let stops = 0;

    expect(
      await startWithFailureCleanup(
        () => Promise.resolve("running"),
        () => {
          stops += 1;
        },
      ),
    ).toBe("running");
    expect(stops).toBe(0);
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
