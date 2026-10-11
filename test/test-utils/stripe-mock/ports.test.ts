// test-groups: run-alone - the unload tests fire the isolate's unload
// listeners by hand, and a shared isolate would run other suites' unload
// cleanup with them, dropping its golden database and suite mock.
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { type Stub, stub } from "@std/testing/mock";
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

/** Offers one port for the kernel's port-0 looks, once or on every look, so
 * a handout is driven against one port number. */
const offerPort = (port: number, everyLook: boolean): Stub => {
  const realListen = Deno.listen;
  let offered = false;
  return stub(Deno, "listen", ((options: Deno.ListenOptions) => {
    if (offered && !everyLook) return realListen(options);
    offered = true;
    return realListen({ ...options, port });
  }) as typeof Deno.listen);
};

describe("handing out ports", () => {
  test("does not hand out a port another handout still holds", async () => {
    await withUnusedPort(async (held) => {
      // The next look at the kernel offers the port the handout above still
      // holds, which is what a raced handout sees.
      using _forced = offerPort(held, false);

      await withUnusedPort(async (second) => {
        expect(second).not.toBe(held);
      });
    });
  });

  test("fails loudly when every try lands on a held port", async () => {
    await withUnusedPort(async (held) => {
      // Every look at the kernel offers the port the handout above holds, as
      // if the machine had nothing else free and it kept being taken.
      using _forced = offerPort(held, true);

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

  test("releases a claim when the isolate exits before the body finished", async () => {
    // The body never finishes, the way an interrupted test leaves its
    // handout. Its claim has nobody left to release it but the isolate's
    // exit, which this test fires by hand.
    let abandonedPort = 0;
    withUnusedPort((port) => {
      abandonedPort = port;
      return new Promise<void>(() => {});
    });

    // Every look at the kernel offers the abandoned handout's port, so the
    // replacement owner below can only receive that port.
    using _forced = offerPort(abandonedPort, true);

    // An isolate that exits runs its unload listeners. The exit takes the
    // abandoned claim with it.
    globalThis.dispatchEvent(new Event("unload"));

    await withUnusedPort(async (claimed) => {
      // The abandoned claim is gone, so the replacement owner receives the
      // same port instead of failing on every try.
      expect(claimed).toBe(abandonedPort);
    });
  });

  test("keeps a rebound claim when the abandoned body settles after the exit", async () => {
    let abandonedPort = 0;
    let resumeAbandoned = () => {};
    const abandonedSettles = new Promise<void>((resolve) => {
      resumeAbandoned = resolve;
    });
    // The body is still pending when the isolate exits. The runner polls the
    // event loop once more after the exit, so this body can settle then.
    const abandoned = withUnusedPort((port) => {
      abandonedPort = port;
      return abandonedSettles;
    });

    // The exit released the abandoned claim, and a newer owner received the
    // same port and still holds it.
    using _forced = offerPort(abandonedPort, true);
    globalThis.dispatchEvent(new Event("unload"));
    let resumeRebound = () => {};
    const reboundSettles = new Promise<void>((resolve) => {
      resumeRebound = resolve;
    });
    const rebound = withUnusedPort((port) => {
      expect(port).toBe(abandonedPort);
      return reboundSettles;
    });

    // The abandoned body settles after the exit. Its release is already
    // done, so the rebound claim must stay the new owner's.
    resumeAbandoned();
    await abandoned;

    // The new owner finishes and releases its own claim without error.
    resumeRebound();
    await rebound;
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
