import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { type Spy, spy, stub } from "@std/testing/mock";
import {
  createRequestTimer,
  logDebug,
  logRequest,
  setSuppressDebugLogs,
  setSuppressRequestLogs,
} from "#shared/logger.ts";

describe("logRequest", () => {
  let debugSpy: Spy;

  beforeEach(() => {
    setSuppressRequestLogs(false);
    debugSpy = spy(console, "debug");
  });

  afterEach(() => {
    debugSpy.restore();
    setSuppressRequestLogs(null);
  });

  /** Assert that the spy captured a specific log message */
  const expectLogged = (message: string) => {
    const found = debugSpy.calls.some((c) => c.args[0] === message);
    expect(found).toBe(true);
  };

  test("logs request with redacted path", () => {
    logRequest({
      durationMs: 42,
      method: "GET",
      path: "/ticket/my-listing",
      status: 200,
    });
    expectLogged("[Request] GET /ticket/[redacted] 200 42ms");
  });

  test("logs POST request with redacted ID", () => {
    logRequest({
      durationMs: 100,
      method: "POST",
      path: "/admin/listings/123",
      status: 201,
    });
    expectLogged("[Request] POST /admin/listings/[id] 201 100ms");
  });

  test("logs error status codes", () => {
    logRequest({ durationMs: 5, method: "GET", path: "/admin", status: 403 });
    expectLogged("[Request] GET /admin 403 5ms");
  });

  test("suppresses logs when override is true", () => {
    setSuppressRequestLogs(true);
    logRequest({
      durationMs: 1,
      method: "POST",
      path: "/admin/login",
      status: 302,
    });
    expect(debugSpy.calls.length).toBe(0);
  });

  test("falls back to env var when override is null", () => {
    setSuppressRequestLogs(null);
    Deno.env.set("TEST_SUPPRESS_REQUEST_LOGS", "1");
    try {
      logRequest({ durationMs: 1, method: "GET", path: "/admin", status: 200 });
      expect(debugSpy.calls.length).toBe(0);
    } finally {
      Deno.env.delete("TEST_SUPPRESS_REQUEST_LOGS");
    }
  });
});

describe("logDebug", () => {
  let debugSpy: Spy;

  beforeEach(() => {
    setSuppressDebugLogs(false);
    debugSpy = spy(console, "debug");
  });

  afterEach(() => {
    debugSpy.restore();
    setSuppressDebugLogs(null);
  });

  test("formats message with category prefix", () => {
    logDebug("Setup", "Validation passed");
    expect(debugSpy.calls[0]?.args[0]).toBe("[Setup] Validation passed");
  });

  test("suppresses output when setSuppressDebugLogs(true)", () => {
    setSuppressDebugLogs(true);
    logDebug("Migration", "Step 1");
    expect(debugSpy.calls.length).toBe(0);
  });

  test("emits output when setSuppressDebugLogs(false)", () => {
    logDebug("Migration", "Step 1");
    expect(debugSpy.calls.length).toBe(1);
  });
});

describe("createRequestTimer", () => {
  test("returns non-negative integer", () => {
    const getElapsed = createRequestTimer();
    const elapsed = getElapsed();
    expect(Number.isInteger(elapsed)).toBe(true);
    expect(elapsed).toBeGreaterThanOrEqual(0);
  });

  test("successive calls return non-decreasing values", () => {
    const getElapsed = createRequestTimer();
    const first = getElapsed();
    const second = getElapsed();
    expect(second).toBeGreaterThanOrEqual(first);
  });

  test("reports elapsed as now minus start, not a ratio", () => {
    // Drive performance.now() deterministically so the elapsed value is the
    // exact difference (subtraction), not now/start (which would round to ~1).
    let clock = 1000;
    const perfStub = stub(performance, "now", () => clock);
    try {
      const getElapsed = createRequestTimer(); // start = 1000
      clock = 1500;
      expect(getElapsed()).toBe(500);
    } finally {
      perfStub.restore();
    }
  });
});
