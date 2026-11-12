import { assertArrayIncludes, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  it as test,
} from "@std/testing/bdd";
import { handleRequest } from "#routes";
import {
  isDemoMode,
  resetDemoMode,
  setDemoModeForTest,
} from "#shared/demo/mode.ts";
import {
  ATTENDEE_DEMO_FIELDS,
  applyDemoOverrides,
  LISTING_DEMO_FIELDS,
  LOGISTICS_DEMO_FIELDS,
} from "#shared/demo/overrides.ts";
import * as demoSamples from "#shared/demo/samples.ts";
import {
  DEMO_EMAILS,
  DEMO_LISTING_DESCRIPTIONS,
  DEMO_LISTING_LOCATIONS,
  DEMO_LISTING_NAMES,
  DEMO_NAMES,
} from "#shared/demo/samples.ts";
import { FormParams } from "#shared/form-data.ts";
import {
  createTestDbWithSetup,
  describeWithEnv,
  resetDb,
} from "#test-utils/db.ts";
import { setupTestEncryptionKey } from "#test-utils/env.ts";
import { mockRequest } from "#test-utils/mocks.ts";

describe("demo sample pools", () => {
  // applyDemoOverrides only replaces fields that arrive non-empty, so a blank
  // sample would silently erase real submitted data. Walking every exported
  // pool keeps that invariant pinned for pools added later too.
  test("every exported pool has entries and no entry is empty", () => {
    const pools = Object.entries(demoSamples).filter(
      (entry): entry is [string, readonly string[]] => Array.isArray(entry[1]),
    );
    expect(pools.length).toBeGreaterThan(0);
    for (const [name, pool] of pools) {
      expect(pool.length, name).toBeGreaterThan(0);
      for (const value of pool) {
        expect(typeof value, name).toBe("string");
        expect(value.length, `${name} has an empty entry`).toBeGreaterThan(0);
      }
    }
  });
});

describeWithEnv("isDemoMode", { env: { DEMO_MODE: undefined } }, () => {
  beforeEach(() => setDemoModeForTest(false));
  afterEach(() => setDemoModeForTest(false));

  test("returns false when DEMO_MODE is not set", () => {
    expect(isDemoMode()).toBe(false);
  });

  test("returns true when DEMO_MODE is 'true'", () => {
    Deno.env.set("DEMO_MODE", "true");
    resetDemoMode();
    expect(isDemoMode()).toBe(true);
  });

  test("returns false when DEMO_MODE is any other value", () => {
    Deno.env.set("DEMO_MODE", "false");
    resetDemoMode();
    expect(isDemoMode()).toBe(false);
  });

  test("caches the result across calls", () => {
    Deno.env.set("DEMO_MODE", "true");
    resetDemoMode();
    expect(isDemoMode()).toBe(true);
    // Change env after first call - should still return cached value
    Deno.env.set("DEMO_MODE", "false");
    expect(isDemoMode()).toBe(true);
  });

  test("resetDemoMode clears the cache", () => {
    Deno.env.set("DEMO_MODE", "true");
    resetDemoMode();
    expect(isDemoMode()).toBe(true);
    Deno.env.set("DEMO_MODE", "false");
    resetDemoMode();
    expect(isDemoMode()).toBe(false);
  });
});

describe("applyDemoOverrides", () => {
  beforeEach(() => setDemoModeForTest(false));
  afterEach(() => setDemoModeForTest(false));

  test("returns form unchanged when demo mode is off", () => {
    const form = new FormParams({
      email: "real@example.com",
      name: "Real Name",
    });
    const result = applyDemoOverrides(form, ATTENDEE_DEMO_FIELDS);
    expect(result.get("name")).toBe("Real Name");
    expect(result.get("email")).toBe("real@example.com");
  });

  test("replaces fields that exist in the form when demo mode is on", () => {
    setDemoModeForTest(true);
    const form = new FormParams({
      email: "real@example.com",
      name: "Real Name",
    });
    applyDemoOverrides(form, ATTENDEE_DEMO_FIELDS);
    expect(form.get("name")).not.toBe("Real Name");
    assertArrayIncludes(DEMO_NAMES as readonly string[], [form.get("name")]);
    expect(form.get("email")).not.toBe("real@example.com");
    assertArrayIncludes(DEMO_EMAILS as readonly string[], [form.get("email")]);
  });

  test("clears pinned coordinates outright instead of substituting text", () => {
    setDemoModeForTest(true);
    const form = new FormParams({
      address: "10 Real Street",
      lat: "51.5074",
      lng: "-0.1278",
    });
    applyDemoOverrides(form, LOGISTICS_DEMO_FIELDS);
    expect(form.get("lat")).toBe("");
    expect(form.get("lng")).toBe("");
    expect(form.get("address")).not.toBe("10 Real Street");
  });

  test("skips fields not present in the form", () => {
    setDemoModeForTest(true);
    const form = new FormParams({ name: "Real Name" });
    applyDemoOverrides(form, ATTENDEE_DEMO_FIELDS);
    expect(form.has("email")).toBe(false);
    expect(form.has("phone")).toBe(false);
  });

  test("skips empty-string fields", () => {
    setDemoModeForTest(true);
    const form = new FormParams({ email: "", name: "Real Name" });
    applyDemoOverrides(form, ATTENDEE_DEMO_FIELDS);
    expect(form.get("email")).toBe("");
    assertArrayIncludes(DEMO_NAMES as readonly string[], [form.get("name")]);
  });

  test("returns the same form instance", () => {
    setDemoModeForTest(true);
    const form = new FormParams({ name: "Test" });
    const result = applyDemoOverrides(form, ATTENDEE_DEMO_FIELDS);
    expect(result).toBe(form);
  });

  test("does not modify fields not in the mapping", () => {
    setDemoModeForTest(true);
    const form = new FormParams({ csrf_token: "abc123", name: "Real" });
    applyDemoOverrides(form, ATTENDEE_DEMO_FIELDS);
    expect(form.get("csrf_token")).toBe("abc123");
  });

  test("works with listing demo fields", () => {
    setDemoModeForTest(true);
    const form = new FormParams({
      description: "My description",
      location: "My location",
      name: "My Listing",
    });
    applyDemoOverrides(form, LISTING_DEMO_FIELDS);
    assertArrayIncludes(DEMO_LISTING_NAMES as readonly string[], [
      form.get("name"),
    ]);
    assertArrayIncludes(DEMO_LISTING_DESCRIPTIONS as readonly string[], [
      form.get("description"),
    ]);
    assertArrayIncludes(DEMO_LISTING_LOCATIONS as readonly string[], [
      form.get("location"),
    ]);
  });
});

describe("layout banner integration", () => {
  beforeAll(async () => {
    setupTestEncryptionKey();
    await createTestDbWithSetup();
  });

  afterAll(() => {
    setDemoModeForTest(false);
    resetDb();
  });

  test("renders demo banner in page when demo mode is active", async () => {
    setDemoModeForTest(true);
    const response = await handleRequest(mockRequest("/admin/login"));
    const html = await response.text();
    expect(response.status).toBe(200);
    assertStringIncludes(html, "Demo Mode");
  });
});
