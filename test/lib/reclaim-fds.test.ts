import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  maybeReclaimLeakedFds,
  RECLAIM_FDS_EVERY,
} from "#test-utils/reclaim-fds.ts";

// Any run of N consecutive calls straddles exactly N / RECLAIM_FDS_EVERY reclaim
// boundaries regardless of the shared counter's starting phase, so these
// assertions are independent of test order and of any DB setups that also
// advanced the counter.
describe("maybeReclaimLeakedFds", () => {
  test("invokes an explicitly injected gc once per RECLAIM_FDS_EVERY calls", () => {
    let calls = 0;
    const gc = () => {
      calls += 1;
    };
    for (let i = 0; i < RECLAIM_FDS_EVERY * 3; i++) maybeReclaimLeakedFds(gc);
    expect(calls).toBe(3);
  });

  test("is a safe no-op on a boundary call when gc is genuinely unavailable", () => {
    // The harness runs with --expose-gc, so passing `undefined` would fall back
    // to the (present) default. Actually clear globalThis.gc to exercise the
    // absent path — a bare `deno test` without the flag.
    const glob = globalThis as { gc?: (() => void) | undefined };
    const original = glob.gc;
    glob.gc = undefined;
    try {
      let threw = false;
      try {
        for (let i = 0; i < RECLAIM_FDS_EVERY; i++) maybeReclaimLeakedFds();
      } catch {
        threw = true;
      }
      expect(threw).toBe(false);
    } finally {
      glob.gc = original;
    }
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
