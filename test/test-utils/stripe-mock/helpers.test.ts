import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  PORT_STEAL_TRIES,
  retryWhilePortTaken,
  startFailedOrPortTaken,
} from "#test/test-utils/stripe-mock/helpers.ts";

/** Stands in for a mock that started, which is what a taken port looks like. */
const startedMock = () =>
  Promise.resolve({
    port: 1,
    stop: () => Promise.resolve(),
    stopNow: () => {},
  });

describe("telling a failed start from a taken port", () => {
  test("says the port was taken when starting worked", async () => {
    expect(await startFailedOrPortTaken(startedMock)).toBe(true);
  });

  test("says the port was not taken when starting failed", async () => {
    const failing = () => Promise.reject(new Error("no good"));

    expect(await startFailedOrPortTaken(failing)).toBe(false);
  });

  test("checks the failure said what the test asked about", async () => {
    const failing = () => Promise.reject(new Error("wrong binary"));

    await expect(
      startFailedOrPortTaken(failing, "install lock"),
    ).rejects.toThrow();
  });
});

describe("asking again when the port keeps being taken", () => {
  test("stops as soon as the start really failed", async () => {
    let asked = 0;
    await retryWhilePortTaken(() => {
      asked += 1;
      return Promise.resolve(false);
    });

    expect(asked).toBe(1);
  });

  test("asks again while the port keeps being taken", async () => {
    let asked = 0;
    await retryWhilePortTaken(() => {
      asked += 1;
      return Promise.resolve(asked < 3);
    });

    expect(asked).toBe(3);
  });

  test("gives up loudly when the port is taken every time", async () => {
    let asked = 0;
    const alwaysTaken = () => {
      asked += 1;
      return Promise.resolve(true);
    };

    await expect(retryWhilePortTaken(alwaysTaken)).rejects.toThrow(
      "kept succeeding",
    );
    expect(asked).toBe(PORT_STEAL_TRIES);
  });
});
