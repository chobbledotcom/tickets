import { expect } from "@std/expect";
import { afterEach, beforeEach, it as test } from "@std/testing/bdd";
import { spy } from "@std/testing/mock";
import {
  ErrorCode,
  getRequestId,
  logDebug,
  logErrorLocal,
  logRequest,
  runWithRequestId,
  setSuppressRequestLogs,
} from "#lib/logger.ts";
import { describeWithEnv } from "#test-utils";

describeWithEnv("runWithRequestId", { env: { NTFY_URL: undefined } }, () => {
  beforeEach(() => {
    setSuppressRequestLogs(false);
  });

  afterEach(() => {
    setSuppressRequestLogs(null);
  });

  test("getRequestId returns 4-char hex ID inside request context", () => {
    runWithRequestId(() => {
      expect(getRequestId()).toMatch(/^[0-9a-f]{4}$/);
    });
  });

  test("getRequestId returns empty string outside request context", () => {
    expect(getRequestId()).toBe("");
  });

  test("prefixes logRequest with request ID", () => {
    const debugSpy = spy(console, "debug");
    try {
      let id = "";
      runWithRequestId(() => {
        id = getRequestId();
        logRequest({
          method: "GET",
          path: "/admin",
          status: 200,
          durationMs: 10,
        });
      });

      expect(
        debugSpy.calls.some(
          (c) => c.args[0] === `[${id}] [Request] GET /admin 200 10ms`,
        ),
      ).toBe(true);
    } finally {
      debugSpy.restore();
    }
  });

  test("prefixes logErrorLocal with same request ID", () => {
    const errorSpy = spy(console, "error");
    try {
      let id = "";
      runWithRequestId(() => {
        id = getRequestId();
        logErrorLocal({ code: ErrorCode.DB_CONNECTION });
      });

      expect(
        errorSpy.calls.some(
          (c) => c.args[0] === `[${id}] [Error] E_DB_CONNECTION`,
        ),
      ).toBe(true);
    } finally {
      errorSpy.restore();
    }
  });

  test("prefixes logDebug with request ID", () => {
    const debugSpy = spy(console, "debug");
    try {
      let id = "";
      runWithRequestId(() => {
        id = getRequestId();
        logDebug("Setup", "test message");
      });

      expect(
        debugSpy.calls.some(
          (c) => c.args[0] === `[${id}] [Setup] test message`,
        ),
      ).toBe(true);
    } finally {
      debugSpy.restore();
    }
  });

  test("different requests get different IDs", () => {
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) {
      runWithRequestId(() => {
        ids.push(getRequestId());
      });
    }
    const unique = new Set(ids);
    expect(unique.size).toBeGreaterThan(1);
  });

  test("no prefix outside request context", () => {
    const debugSpy = spy(console, "debug");
    try {
      logRequest({
        method: "GET",
        path: "/admin",
        status: 200,
        durationMs: 10,
      });

      expect(
        debugSpy.calls.some(
          (c) => c.args[0] === "[Request] GET /admin 200 10ms",
        ),
      ).toBe(true);
    } finally {
      debugSpy.restore();
    }
  });
});
