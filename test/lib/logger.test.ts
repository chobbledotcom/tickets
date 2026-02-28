import { afterEach, beforeEach, describe, expect, spy, stub, test } from "#test-compat";
import type { Spy } from "#test-compat";
import {
  createRequestTimer,
  ErrorCode,
  logDebug,
  logError,
  logRequest,
  redactPath,
  runWithRequestId,
} from "#lib/logger.ts";

describe("logger", () => {
  describe("redactPath", () => {
    test("redacts ticket slugs", () => {
      expect(redactPath("/ticket/summer-concert-2024")).toBe(
        "/ticket/[redacted]",
      );
    });

    test("redacts simple ticket slugs", () => {
      expect(redactPath("/ticket/abc")).toBe("/ticket/[redacted]");
    });

    test("preserves /ticket without slug", () => {
      expect(redactPath("/ticket")).toBe("/ticket");
    });

    test("redacts numeric IDs in admin paths", () => {
      expect(redactPath("/admin/events/123")).toBe("/admin/events/[id]");
    });

    test("redacts multiple numeric IDs", () => {
      expect(redactPath("/admin/events/123/attendees/456")).toBe(
        "/admin/events/[id]/attendees/[id]",
      );
    });

    test("preserves paths without dynamic segments", () => {
      expect(redactPath("/admin")).toBe("/admin");
      expect(redactPath("/admin/events")).toBe("/admin/events");
      expect(redactPath("/setup")).toBe("/setup");
      expect(redactPath("/")).toBe("/");
    });

    test("preserves payment paths", () => {
      expect(redactPath("/payment/success")).toBe("/payment/success");
      expect(redactPath("/payment/webhook")).toBe("/payment/webhook");
    });

    test("handles trailing slashes with IDs", () => {
      expect(redactPath("/admin/events/123/")).toBe("/admin/events/[id]/");
    });
  });

  describe("logRequest", () => {
    let debugSpy: Spy<Console, [message?: unknown, ...args: unknown[]], void>;

    beforeEach(() => {
      debugSpy = spy(console, "debug");
    });

    afterEach(() => {
      debugSpy.restore();
    });

    test("logs request with redacted path", () => {
      logRequest({
        method: "GET",
        path: "/ticket/my-event",
        status: 200,
        durationMs: 42,
      });

      expect(debugSpy.calls[0]!.args).toEqual([
        "[Request] GET /ticket/[redacted] 200 42ms",
      ]);
    });

    test("logs POST request", () => {
      logRequest({
        method: "POST",
        path: "/admin/events/123",
        status: 201,
        durationMs: 100,
      });

      expect(debugSpy.calls[0]!.args).toEqual([
        "[Request] POST /admin/events/[id] 201 100ms",
      ]);
    });

    test("logs error status codes", () => {
      logRequest({
        method: "GET",
        path: "/admin",
        status: 403,
        durationMs: 5,
      });

      expect(debugSpy.calls[0]!.args).toEqual(["[Request] GET /admin 403 5ms"]);
    });
  });

  describe("logError", () => {
    let errorSpy: Spy<Console, [message?: unknown, ...args: unknown[]], void>;

    beforeEach(() => {
      errorSpy = spy(console, "error");
    });

    afterEach(() => {
      errorSpy.restore();
    });

    test("logs error code only", () => {
      logError({ code: ErrorCode.DB_CONNECTION });

      expect(errorSpy.calls[0]!.args).toEqual(["[Error] E_DB_CONNECTION"]);
    });

    test("logs error with event ID", () => {
      logError({ code: ErrorCode.CAPACITY_EXCEEDED, eventId: 42 });

      expect(errorSpy.calls[0]!.args).toEqual([
        "[Error] E_CAPACITY_EXCEEDED event=42",
      ]);
    });

    test("logs error with attendee ID", () => {
      logError({ code: ErrorCode.WEBHOOK_SEND, attendeeId: 99 });

      expect(errorSpy.calls[0]!.args).toEqual(["[Error] E_WEBHOOK_SEND attendee=99"]);
    });

    test("logs error with detail", () => {
      logError({ code: ErrorCode.STRIPE_SIGNATURE, detail: "mismatch" });

      expect(errorSpy.calls[0]!.args).toEqual([
        '[Error] E_STRIPE_SIGNATURE detail="mismatch"',
      ]);
    });

    test("logs error with all context", () => {
      logError({
        code: ErrorCode.NOT_FOUND_EVENT,
        eventId: 1,
        attendeeId: 2,
        detail: "inactive",
      });

      expect(errorSpy.calls[0]!.args).toEqual([
        '[Error] E_NOT_FOUND_EVENT event=1 attendee=2 detail="inactive"',
      ]);
    });

    test("sends ntfy notification when NTFY_URL is configured", () => {
      Deno.env.set("NTFY_URL", "https://ntfy.sh/test-topic");
      const fetchStub = stub(globalThis, "fetch", () => Promise.resolve(new Response()));

      logError({ code: ErrorCode.DB_QUERY });

      expect(fetchStub.calls.length).toBe(1);
      const [url, options] = fetchStub.calls[0]!.args as [string, RequestInit];
      expect(url).toBe("https://ntfy.sh/test-topic");
      expect(options.body).toBe("E_DB_QUERY");

      fetchStub.restore();
      Deno.env.delete("NTFY_URL");
    });
  });

  describe("logDebug", () => {
    let debugSpy: Spy<Console, [message?: unknown, ...args: unknown[]], void>;

    beforeEach(() => {
      debugSpy = spy(console, "debug");
    });

    afterEach(() => {
      debugSpy.restore();
    });

    test("logs with Setup category", () => {
      logDebug("Setup", "Validation passed");

      expect(debugSpy.calls[0]!.args).toEqual(["[Setup] Validation passed"]);
    });

    test("logs with Webhook category", () => {
      logDebug("Webhook", "Sending notification");

      expect(debugSpy.calls[0]!.args).toEqual(["[Webhook] Sending notification"]);
    });

    test("logs with Stripe category", () => {
      logDebug("Stripe", "Creating checkout session");

      expect(debugSpy.calls[0]!.args).toEqual(["[Stripe] Creating checkout session"]);
    });
  });

  describe("createRequestTimer", () => {
    test("returns elapsed time in milliseconds", async () => {
      const getElapsed = createRequestTimer();

      // Wait a small amount
      await new Promise((resolve) => setTimeout(resolve, 10));

      const elapsed = getElapsed();
      expect(elapsed).toBeGreaterThanOrEqual(10);
      expect(elapsed).toBeLessThan(100); // Sanity check
    });

    test("returns integer values", () => {
      const getElapsed = createRequestTimer();
      const elapsed = getElapsed();

      expect(Number.isInteger(elapsed)).toBe(true);
    });
  });

  describe("ErrorCode constants", () => {
    test("has expected error codes", () => {
      expect(ErrorCode.DB_CONNECTION).toBe("E_DB_CONNECTION");
      expect(ErrorCode.CAPACITY_EXCEEDED).toBe("E_CAPACITY_EXCEEDED");
      expect(ErrorCode.DECRYPT_FAILED).toBe("E_DECRYPT_FAILED");
      expect(ErrorCode.AUTH_CSRF_MISMATCH).toBe("E_AUTH_CSRF_MISMATCH");
      expect(ErrorCode.STRIPE_SIGNATURE).toBe("E_STRIPE_SIGNATURE");
      expect(ErrorCode.WEBHOOK_SEND).toBe("E_WEBHOOK_SEND");
      expect(ErrorCode.DOMAIN_REJECTED).toBe("E_DOMAIN_REJECTED");
    });
  });

  describe("runWithRequestId", () => {
    test("prefixes logRequest with 4-char hex ID", () => {
      const debugSpy = spy(console, "debug");

      runWithRequestId(() => {
        logRequest({ method: "GET", path: "/admin", status: 200, durationMs: 10 });
      });

      const message = debugSpy.calls[0]!.args[0] as string;
      expect(message).toMatch(/^\[[0-9a-f]{4}\] \[Request\] GET \/admin 200 10ms$/);
      debugSpy.restore();
    });

    test("prefixes logError with same request ID", () => {
      const debugSpy = spy(console, "debug");
      const errorSpy = spy(console, "error");

      runWithRequestId(() => {
        logRequest({ method: "GET", path: "/admin", status: 200, durationMs: 5 });
        logError({ code: ErrorCode.DB_CONNECTION });
      });

      const requestMsg = debugSpy.calls[0]!.args[0] as string;
      const errorMsg = errorSpy.calls[0]!.args[0] as string;
      const requestId = requestMsg.slice(1, 5);
      expect(errorMsg).toBe(`[${requestId}] [Error] E_DB_CONNECTION`);

      debugSpy.restore();
      errorSpy.restore();
    });

    test("prefixes logDebug with request ID", () => {
      const debugSpy = spy(console, "debug");

      runWithRequestId(() => {
        logDebug("Setup", "test message");
      });

      const message = debugSpy.calls[0]!.args[0] as string;
      expect(message).toMatch(/^\[[0-9a-f]{4}\] \[Setup\] test message$/);
      debugSpy.restore();
    });

    test("different requests get different IDs", () => {
      const debugSpy = spy(console, "debug");

      const ids: string[] = [];
      for (let i = 0; i < 10; i++) {
        runWithRequestId(() => {
          logRequest({ method: "GET", path: "/", status: 200, durationMs: 0 });
        });
        ids.push((debugSpy.calls[i]!.args[0] as string).slice(1, 5));
      }

      // With 65536 possible values, 10 samples should not all be identical
      const unique = new Set(ids);
      expect(unique.size).toBeGreaterThan(1);
      debugSpy.restore();
    });

    test("no prefix outside request context", () => {
      const debugSpy = spy(console, "debug");

      logRequest({ method: "GET", path: "/admin", status: 200, durationMs: 10 });

      expect(debugSpy.calls[0]!.args).toEqual(["[Request] GET /admin 200 10ms"]);
      debugSpy.restore();
    });
  });
});
