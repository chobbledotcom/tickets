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

// A DB-backed suite overlays DB_URL with a fresh temp file per test. The DB
// resource (tracked by prepareTestClient) must be disposed by resetDb, so the
// overlay does not keep pointing at the deleted temp file after the suite.
const realDbUrl = getRealEnv("DB_URL");
const suiteTempDbUrl: { value: string | undefined } = { value: undefined };
describeWithEnv("describeWithEnv DB env (temp file)", { db: true }, () => {
  test("overlays DB_URL with a fresh temp file during the test", () => {
    const url = getEnv("DB_URL");
    expect(url?.startsWith("file:")).toBe(true);
    expect(url).not.toBe(realDbUrl);
    suiteTempDbUrl.value = url;
  });
});

describe("describeWithEnv DB env (restored after)", () => {
  test("DB_URL overlay does not keep the deleted temp file from the suite", () => {
    expect(getEnv("DB_URL")).not.toBe(suiteTempDbUrl.value);
  });
});

// A mixed suite (db: true AND env) stacks: DB scope first, suite env on top.
// The afterEach must dispose the suite env BEFORE resetDb (LIFO), or
// env.dispose() resurrects the deleted DB_URL.
const mixedSuiteTempDbUrl: { value: string | undefined } = { value: undefined };
describeWithEnv(
  "describeWithEnv mixed DB+env (stacked)",
  { db: true, env: { [OUTER_KEY]: "on" } },
  () => {
    test("sees both DB_URL and outer env during the test", () => {
      expect(getEnv("DB_URL")?.startsWith("file:")).toBe(true);
      mixedSuiteTempDbUrl.value = getEnv("DB_URL");
      expect(getEnv(OUTER_KEY)).toBe("on");
    });
  },
);

describe("describeWithEnv mixed DB+env (restored after)", () => {
  test("neither DB_URL nor outer env leaks the deleted temp file", () => {
    expect(getEnv("DB_URL")).not.toBe(mixedSuiteTempDbUrl.value);
    expect(getEnv(OUTER_KEY)).toBeUndefined();
  });
});

// A body that opens an inner scope but fails to dispose it (simulating a
// body afterEach that threw before reaching its dispose call). The factory
// afterEach must still dispose the outer env scope.
describeWithEnv(
  "describeWithEnv cleanup (body left inner scope undisposed)",
  { env: { [OUTER_KEY]: "on" } },
  () => {
    beforeEach(() => {
      withEnv({ [INNER_KEY]: "set" });
    });

    test("sees both scopes", () => {
      expect(getEnv(OUTER_KEY)).toBe("on");
      expect(getEnv(INNER_KEY)).toBe("set");
    });
  },
);

describeWithEnv(
  "describeWithEnv cleanup (outer env gone after leak)",
  {},
  () => {
    test("does not inherit the outer env despite the inner scope leak", () => {
      expect(getRealEnv(OUTER_KEY)).toBeUndefined();
      expect(getEnv(OUTER_KEY)).toBeUndefined();
    });
  },
);
