import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  maybeReclaimLeakedFds,
  RECLAIM_FDS_EVERY,
} from "#test-utils/reclaim-fds.ts";

// Any window of N consecutive calls straddles exactly N / RECLAIM_FDS_EVERY
// reclaim boundaries, regardless of the shared counter's starting phase — so
// these assertions are independent of test order and of any DB setups that also
// advanced the counter.
describe("maybeReclaimLeakedFds", () => {
  test("invokes gc exactly once per RECLAIM_FDS_EVERY calls", () => {
    let calls = 0;
    const gc = () => {
      calls += 1;
    };
    for (let i = 0; i < RECLAIM_FDS_EVERY * 3; i++) maybeReclaimLeakedFds(gc);
    expect(calls).toBe(3);
  });

  test("is a safe no-op when gc is unavailable, even on a boundary call", () => {
    let threw = false;
    try {
      // Spans a reclaim boundary with no gc — must not throw.
      for (let i = 0; i < RECLAIM_FDS_EVERY; i++) {
        maybeReclaimLeakedFds(undefined);
      }
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
  });

  test("defaults to globalThis.gc when called without an argument", () => {
    const glob = globalThis as { gc?: (() => void) | undefined };
    const original = glob.gc;
    let called = 0;
    glob.gc = () => {
      called += 1;
    };
    try {
      for (let i = 0; i < RECLAIM_FDS_EVERY; i++) maybeReclaimLeakedFds();
      expect(called).toBe(1);
    } finally {
      glob.gc = original;
    }
  });
});
