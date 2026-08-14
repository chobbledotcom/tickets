/** Direct tests for the config and log helpers. */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import {
  config,
  needsTunnel,
  newBookerIdentity,
  randomId,
  randomOwnerCredentials,
} from "#e2e/config.ts";
import { fail, log, step, warn } from "#e2e/log.ts";

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
    expect(id1.email).toContain("abc123");
    expect(id1.email).toContain("@mailinator.com");
    expect(id1.name).toContain("E2E Booker");
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
    expect(captured).toContain("▸");
    expect(captured).toContain("hello");
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
    expect(captured).toContain("!");
    expect(captured).toContain("careful");
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
    expect(captured).toContain("✖");
    expect(captured).toContain("broken");
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
    expect(captured).toContain("plain");
  });
});
