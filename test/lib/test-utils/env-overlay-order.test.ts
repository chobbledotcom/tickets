import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { getEnv } from "#shared/env.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { type EnvScope, getRealEnv, withEnv } from "#test-utils/env.ts";

// A suite that turns a feature on for its own tests, and layers a second env
// scope on top (the shape every built-sites suite uses: the outer env from
// describeWithEnv plus a per-test inner scope). The inner scope's dispose must
// run BEFORE the outer env's dispose, or it restores the stale "feature on"
// layer after the outer clear — leaking CAN_BUILD_SITES into the next suite.
describeWithEnv(
  "describeWithEnv nested env (feature on)",
  { env: { CAN_BUILD_SITES: "true" } },
  () => {
    let inner: EnvScope | undefined;
    beforeEach(() => {
      inner = withEnv({ TICKETS_NESTED_ENV_PROBE: "set" });
    });
    afterEach(() => {
      inner?.dispose();
      inner = undefined;
    });

    test("sees the feature enabled inside the suite", () => {
      expect(getEnv("CAN_BUILD_SITES")).toBe("true");
    });
  },
);

// A later suite that never touches CAN_BUILD_SITES. The real environment never
// held it, so if the overlay is clean the lookup is undefined. Before the
// hook-order fix this read "true" — the previous suite's inner dispose had
// restored the "feature on" layer after the outer clear, so the overlay kept
// leaking it across the suite boundary.
describeWithEnv("describeWithEnv nested env (ambient after)", {}, () => {
  test("does not inherit the previous suite's CAN_BUILD_SITES", () => {
    expect(getRealEnv("CAN_BUILD_SITES")).toBeUndefined();
    expect(getEnv("CAN_BUILD_SITES")).toBeUndefined();
  });
});

// The same contract for an env var the inner scope owns, so the regression
// also catches a nested-scope leak of a key the outer env never carried.
describeWithEnv(
  "describeWithEnv nested env (inner key ambient after)",
  {},
  () => {
    test("does not inherit the inner scope's probe key", () => {
      expect(getRealEnv("TICKETS_NESTED_ENV_PROBE")).toBeUndefined();
      expect(getEnv("TICKETS_NESTED_ENV_PROBE")).toBeUndefined();
    });
  },
);

describe("describeWithEnv overlay cleanup (sanity)", () => {
  test("the real process env was never touched", () => {
    expect(getRealEnv("CAN_BUILD_SITES")).toBeUndefined();
    expect(getRealEnv("TICKETS_NESTED_ENV_PROBE")).toBeUndefined();
  });
});
