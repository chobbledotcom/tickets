import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { getEnv } from "#shared/env.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { type EnvScope, getRealEnv, withEnv } from "#test-utils/env.ts";

// Test-only keys the real process environment never carries, so these
// assertions check the overlay alone and never trip on a feature flag the
// runner happens to be launched with.
const OUTER_KEY = "TICKETS_TEST_OVERLAY_OUTER";
const INNER_KEY = "TICKETS_TEST_OVERLAY_INNER";

// A suite that sets an outer env var for its own tests and layers a second,
// per-test env scope on top — the shape every built-sites suite uses (the
// outer env from describeWithEnv plus an inner withEnv opened in the body).
describeWithEnv(
  "describeWithEnv nested env (outer on)",
  { env: { [OUTER_KEY]: "on" } },
  () => {
    let inner: EnvScope;
    beforeEach(() => {
      inner = withEnv({ [INNER_KEY]: "set" });
    });
    afterEach(() => {
      inner.dispose();
    });

    test("sees the outer and inner env enabled inside the suite", () => {
      expect(getEnv(OUTER_KEY)).toBe("on");
      expect(getEnv(INNER_KEY)).toBe("set");
    });
  },
);

// A later suite that never touches the outer key. The overlay must be clean
// after the previous suite, so the lookup falls through to the (empty) real
// environment. This is the contract that breaks if a nested withEnv scope
// disposes AFTER describeWithEnv's own afterEach: the inner dispose restores
// the outer env layer over the cleared overlay, leaking it across the suite
// boundary.
describeWithEnv("describeWithEnv nested env (ambient after)", {}, () => {
  test("does not inherit the previous suite's outer env", () => {
    expect(getRealEnv(OUTER_KEY)).toBeUndefined();
    expect(getEnv(OUTER_KEY)).toBeUndefined();
  });
});

// The inner scope's own key must not leak either, for the same reason.
describeWithEnv(
  "describeWithEnv nested env (inner key ambient after)",
  {},
  () => {
    test("does not inherit the inner scope's key", () => {
      expect(getRealEnv(INNER_KEY)).toBeUndefined();
      expect(getEnv(INNER_KEY)).toBeUndefined();
    });
  },
);

describe("describeWithEnv overlay cleanup (sanity)", () => {
  test("the real process env is never touched", () => {
    expect(getRealEnv(OUTER_KEY)).toBeUndefined();
    expect(getRealEnv(INNER_KEY)).toBeUndefined();
  });
});
