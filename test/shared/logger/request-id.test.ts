import { expect } from "@std/expect";
import { afterEach, beforeEach, it as test } from "@std/testing/bdd";
import { spy, stub } from "@std/testing/mock";
import { setSuppressDebugLogs } from "#shared/log-settings.ts";
import {
  ErrorCode,
  getRequestId,
  logDebug,
  logErrorLocal,
  logRequest,
  runWithRequestId,
  setSuppressRequestLogs,
} from "#shared/logger.ts";
import { describeWithEnv } from "#test-utils/db.ts";

describeWithEnv("runWithRequestId", { env: { NTFY_URL: undefined } }, () => {
  beforeEach(() => {
    setSuppressRequestLogs(false);
    // Debug suppression is module state another test file may have switched
    // on (setupTestEncryptionKey does); these tests assert on logDebug output.
    setSuppressDebugLogs(false);
  });

  afterEach(() => {
    setSuppressRequestLogs(null);
    setSuppressDebugLogs(null);
  });

  test("getRequestId returns 4-char hex ID inside request context", () => {
    runWithRequestId(() => {
      expect(getRequestId()).toMatch(/^[0-9a-f]{4}$/);
    });
  });

  test("pads a small random value to exactly four hex chars", () => {
    // A zeroed buffer forces the shortest possible hex ("0"), so the id is
    // all padding — the case a lucky random draw would never pin down.
    const zeroed = stub(
      crypto,
      "getRandomValues",
      <T extends ArrayBufferView | null>(array: T): T => array,
    );
    try {
      runWithRequestId(() => {
        expect(getRequestId()).toBe("0000");
      });
    } finally {
      zeroed.restore();
    }
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
          durationMs: 10,
          method: "GET",
          path: "/admin",
          status: 200,
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
    // Feed each call a distinct fixed value, so the distinct-ids contract is
    // proven deterministically rather than left to a lucky random draw.
    let draw = 0;
    const counted = stub(
      crypto,
      "getRandomValues",
      <T extends ArrayBufferView | null>(array: T): T => {
        draw += 1;
        new DataView((array as Uint8Array).buffer).setUint16(0, draw);
        return array;
      },
    );
    try {
      const ids = Array.from({ length: 10 }, () =>
        runWithRequestId(getRequestId),
      );
      expect(ids).toEqual([
        "0001",
        "0002",
        "0003",
        "0004",
        "0005",
        "0006",
        "0007",
        "0008",
        "0009",
        "000a",
      ]);
    } finally {
      counted.restore();
    }
  });

  test("no prefix outside request context", () => {
    const debugSpy = spy(console, "debug");
    try {
      logRequest({
        durationMs: 10,
        method: "GET",
        path: "/admin",
        status: 200,
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
