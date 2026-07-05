import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  maybeReclaimLeakedFds,
  RECLAIM_FDS_EVERY,
  reclaimLeakedFdsNow,
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

// Regression coverage for the fd exhaustion the ~400-line test-file split
// exposed: a suite with fewer DB setups than RECLAIM_FDS_EVERY never crossed
// the amortised boundary, so nothing ever reclaimed its leaked descriptors.
// describeWithEnv now calls this at afterAll; these tests pin the unconditional
// contract that makes that teardown effective for even a one-test suite.
describe("reclaimLeakedFdsNow", () => {
  test("invokes an explicitly injected gc on every call, ignoring the counter", () => {
    let calls = 0;
    const gc = () => {
      calls += 1;
    };
    reclaimLeakedFdsNow(gc);
    reclaimLeakedFdsNow(gc);
    expect(calls).toBe(2);
  });

  test("is a safe no-op when gc is genuinely unavailable", () => {
    const glob = globalThis as { gc?: (() => void) | undefined };
    const original = glob.gc;
    glob.gc = undefined;
    try {
      let threw = false;
      try {
        reclaimLeakedFdsNow();
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
      reclaimLeakedFdsNow();
      expect(called).toBe(1);
    } finally {
      glob.gc = original;
    }
  });
});
