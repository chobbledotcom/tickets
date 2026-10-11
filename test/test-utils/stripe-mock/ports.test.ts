import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import {
  expectStartFailsWith,
  startFailedOrPortTaken,
  withFreshPortWhileTaken,
  withUnusedPort,
} from "#test-utils/stripe-mock/ports.ts";

/** Stands in for a mock that started, which is what a taken port looks like. */
const startedMock = () =>
  Promise.resolve({
    port: 1,
    stop: () => Promise.resolve(),
    stopNow: () => {},
  });

describe("handing out ports", () => {
  test("does not hand out a port another handout still holds", async () => {
    await withUnusedPort(async (held) => {
      // The next look at the kernel offers the port the handout above still
      // holds, which is what a raced handout sees.
      const realListen = Deno.listen;
      let offered = false;
      const forcedListen = ((options: Deno.ListenOptions) => {
        if (offered || options.port !== 0) return realListen(options);
        offered = true;
        return realListen({ ...options, port: held });
      }) as typeof Deno.listen;
      using _forced = stub(Deno, "listen", forcedListen);

      await withUnusedPort(async (second) => {
        expect(second).not.toBe(held);
      });
    });
  });

  test("fails loudly when every try lands on a held port", async () => {
    const realListen = Deno.listen;
    const finder = realListen({ hostname: "127.0.0.1", port: 0 });
    const taken = (finder.addr as Deno.NetAddr).port;
    finder.close();
    // Every look at the kernel offers the one port, as if the machine had
    // nothing else free and another handout kept holding it.
    const forcedListen = ((options: Deno.ListenOptions) =>
      options.port === 0
        ? realListen({ ...options, port: taken })
        : realListen(options)) as typeof Deno.listen;
    using _forced = stub(Deno, "listen", forcedListen);

    await withUnusedPort(async (first) => {
      expect(first).toBe(taken);
      await expect(withUnusedPort(() => {})).rejects.toThrow(
        "landed on a port another handout holds",
      );
    });
  });

  test("reports a lock failure it does not recognize", async () => {
    const brokenLocks = (() => {
      throw new Deno.errors.NotFound("no lock folder");
    }) as typeof Deno.openSync;
    using _broken = stub(Deno, "openSync", brokenLocks);

    await expect(withUnusedPort(() => {})).rejects.toThrow("no lock folder");
  });
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
  test("stops as soon as the body says the port was fine", async () => {
    let asked = 0;
    await withFreshPortWhileTaken(() => {
      asked += 1;
      return Promise.resolve(false);
    });

    expect(asked).toBe(1);
  });

  test("asks again while the body says the port was taken", async () => {
    let asked = 0;
    await withFreshPortWhileTaken(() => {
      asked += 1;
      return Promise.resolve(asked < 3);
    });

    expect(asked).toBe(3);
  });

  test("gives up loudly when the port is taken every time", async () => {
    let asked = 0;
    await expect(
      withFreshPortWhileTaken(() => {
        asked += 1;
        return Promise.resolve(true);
      }),
    ).rejects.toThrow("kept succeeding");
    // Pins the forgiveness count the ask-again lives on.
    expect(asked).toBe(5);
  });
});

describe("expecting a start to fail", () => {
  test("asks again on a fresh port when the first one was taken", async () => {
    const portsTried: number[] = [];
    let holder: Deno.Listener | undefined;
    let starts = 0;
    try {
      await expectStartFailsWith((port) => {
        portsTried.push(port);
        starts += 1;
        // The first port is taken by something else, so starting "works".
        // The listener holds it for real, so the kernel cannot hand the
        // same number to the next try.
        if (starts === 1) {
          holder = Deno.listen({ hostname: "127.0.0.1", port });
          return startedMock();
        }
        return Promise.reject(new Error("no good"));
      }, "no good");
    } finally {
      holder?.close();
    }

    expect(starts).toBe(2);
    expect(portsTried[0]).not.toBe(portsTried[1]);
  });

  test("passes as soon as the start fails for the stated reason", async () => {
    let starts = 0;
    await expectStartFailsWith(() => {
      starts += 1;
      return Promise.reject(new Error("install lock write failed"));
    }, "install lock write failed");

    expect(starts).toBe(1);
  });
});
