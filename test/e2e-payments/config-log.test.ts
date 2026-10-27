/** Direct tests for the config and log helpers. */

import { assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import {
  config,
  type EnvLookup,
  needsTunnel,
  newBookerIdentity,
  randomId,
  randomOwnerCredentials,
  readConfig,
} from "#e2e/config.ts";
import { fail, log, step, warn } from "#e2e/log.ts";

/** Build an env lookup from a plain record of raw values. */
const lookupOf =
  (values: Record<string, string | undefined>): EnvLookup =>
  (key) =>
    values[key];

describe("randomId", () => {
  it("produces a lowercase hex string twice the byte length", () => {
    expect(randomId()).toMatch(/^[0-9a-f]{10}$/);
    expect(randomId(3)).toMatch(/^[0-9a-f]{6}$/);
  });

  it("produces unique values across calls", () => {
    expect(randomId()).not.toBe(randomId());
  });
});

describe("randomOwnerCredentials", () => {
  it("returns a username starting with e2e- and a strong password", () => {
    const cred = randomOwnerCredentials();
    expect(cred.username.startsWith("e2e-")).toBe(true);
    expect(cred.password.length).toBeGreaterThan(8);
  });
});

describe("newBookerIdentity", () => {
  it("builds a unique email and name from the run id", () => {
    const id1 = newBookerIdentity("abc123");
    assertStringIncludes(id1.email, "abc123");
    assertStringIncludes(id1.email, "@mailinator.com");
    assertStringIncludes(id1.name, "E2E Booker");
    const id2 = newBookerIdentity("abc123");
    expect(id1.email).not.toBe(id2.email);
  });
});

describe("needsTunnel", () => {
  it("is false for the free target by default", () => {
    expect(needsTunnel("free")).toBe(false);
  });

  it("is true for paid targets by default", () => {
    expect(needsTunnel("stripe")).toBe(true);
    expect(needsTunnel("square")).toBe(true);
    expect(needsTunnel("sumup")).toBe(true);
  });

  it("honours a forced tunnel value over the target default", () => {
    expect(needsTunnel("free", "1")).toBe(true);
    expect(needsTunnel("free", "true")).toBe(true);
    expect(needsTunnel("stripe", "0")).toBe(false);
    expect(needsTunnel("stripe", "yes")).toBe(false);
  });
});

describe("readConfig env parsing", () => {
  it("trims text values and falls back when blank or unset", () => {
    expect(readConfig(lookupOf({})).artifactsDir).toBe("artifacts");
    expect(
      readConfig(lookupOf({ E2E_ARTIFACTS_DIR: "  out  " })).artifactsDir,
    ).toBe("out");
    expect(
      readConfig(lookupOf({ E2E_ARTIFACTS_DIR: "   " })).artifactsDir,
    ).toBe("artifacts");
  });

  it("parses boolean values as 1, true, or yes in any case", () => {
    expect(readConfig(lookupOf({})).headless).toBe(true);
    expect(readConfig(lookupOf({ HEADLESS: "1" })).headless).toBe(true);
    expect(readConfig(lookupOf({ HEADLESS: "TRUE" })).headless).toBe(true);
    expect(readConfig(lookupOf({ HEADLESS: "yes" })).headless).toBe(true);
    expect(readConfig(lookupOf({ HEADLESS: "no" })).headless).toBe(false);
  });

  it("parses numeric values and falls back when absent or not a number", () => {
    expect(readConfig(lookupOf({})).unitPrice).toBe(137);
    expect(readConfig(lookupOf({ E2E_UNIT_PRICE: "999" })).unitPrice).toBe(999);
    expect(readConfig(lookupOf({ E2E_UNIT_PRICE: "abc" })).unitPrice).toBe(137);
    expect(readConfig(lookupOf({ E2E_UNIT_PRICE: "" })).unitPrice).toBe(137);
  });
});

describe("config defaults", () => {
  it("has a non-zero unit price and a test encryption key", () => {
    expect(config.unitPrice).toBeGreaterThan(0);
    expect(config.dbEncryptionKey.length).toBeGreaterThan(0);
    expect(config.stepTimeoutMs).toBeGreaterThan(0);
    expect(config.startupTimeoutMs).toBeGreaterThan(config.stepTimeoutMs);
  });
});

describe("log functions", () => {
  it("step writes a timestamped line with the prefix arrow", () => {
    const original = console.log;
    let captured = "";
    console.log = (msg: string) => (captured = msg);
    try {
      step("hello");
    } finally {
      console.log = original;
    }
    assertStringIncludes(captured, "▸");
    assertStringIncludes(captured, "hello");
  });

  it("warn writes to console.warn with an exclamation", () => {
    const original = console.warn;
    let captured = "";
    console.warn = (msg: string) => (captured = msg);
    try {
      warn("careful");
    } finally {
      console.warn = original;
    }
    assertStringIncludes(captured, "!");
    assertStringIncludes(captured, "careful");
  });

  it("fail writes to console.error with a cross", () => {
    const original = console.error;
    let captured = "";
    console.error = (msg: string) => (captured = msg);
    try {
      fail("broken");
    } finally {
      console.error = original;
    }
    assertStringIncludes(captured, "✖");
    assertStringIncludes(captured, "broken");
  });

  it("log writes to console.log with a timestamp", () => {
    const original = console.log;
    let captured = "";
    console.log = (msg: string) => (captured = msg);
    try {
      log("plain");
    } finally {
      console.log = original;
    }
    assertStringIncludes(captured, "plain");
  });
});
