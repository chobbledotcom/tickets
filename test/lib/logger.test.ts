import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { type Spy, spy, stub } from "@std/testing/mock";
import { getAllActivityLog } from "#lib/db/activityLog.ts";
import {
  createRequestTimer,
  ErrorCode,
  type ErrorCodeType,
  type ErrorContext,
  errorCodeLabel,
  formatErrorMessage,
  formatRequestError,
  getRequestId,
  logDebug,
  logError,
  logErrorLocal,
  logRequest,
  redactPath,
  runWithRequestId,
} from "#lib/logger.ts";
import { flushPendingWork, runWithPendingWork } from "#lib/pending-work.ts";
import {
  createTestDbWithSetup,
  createTestEvent,
  describeWithEnv,
  resetDb,
  setTestEnv,
} from "#test-utils";

// Outer describe ensures sequential execution — logError's fire-and-forget
// promises must settle before later blocks spy on the same console methods.
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

    test("redacts device ID in wallet webservice device paths", () => {
      expect(redactPath("/v1/devices/abc123/registrations/pass.com.test")).toBe(
        "/v1/devices/[redacted]/registrations/pass.com.test",
      );
    });

    test("redacts token in wallet webservice registration paths", () => {
      expect(
        redactPath("/v1/devices/abc123/registrations/pass.com.test/my-token"),
      ).toBe("/v1/devices/[redacted]/registrations/pass.com.test/[redacted]");
    });

    test("redacts token in wallet webservice pass paths", () => {
      expect(redactPath("/v1/passes/pass.com.test/my-token")).toBe(
        "/v1/passes/pass.com.test/[redacted]",
      );
    });

    test("redacts token in wallet download paths", () => {
      expect(redactPath("/wallet/abc123.pkpass")).toBe("/wallet/[redacted]");
    });

    test("redacts token in checkin paths", () => {
      expect(redactPath("/checkin/abc123")).toBe("/checkin/[redacted]");
    });

    test("handles trailing slashes with IDs", () => {
      expect(redactPath("/admin/events/123/")).toBe("/admin/events/[id]/");
    });
  });

  describeWithEnv(
    "logRequest",
    { env: { TEST_SUPPRESS_REQUEST_LOGS: undefined } },
    () => {
      let debugSpy: Spy<Console, [message?: unknown, ...args: unknown[]], void>;

      beforeEach(() => {
        debugSpy = spy(console, "debug");
      });

      afterEach(() => {
        debugSpy.restore();
      });

      test("logs request with redacted path", () => {
        const before = debugSpy.calls.length;
        logRequest({
          method: "GET",
          path: "/ticket/my-event",
          status: 200,
          durationMs: 42,
        });

        const found = debugSpy.calls
          .slice(before)
          .some(
            (c) => c.args[0] === "[Request] GET /ticket/[redacted] 200 42ms",
          );
        expect(found).toBe(true);
      });

      test("logs POST request", () => {
        const before = debugSpy.calls.length;
        logRequest({
          method: "POST",
          path: "/admin/events/123",
          status: 201,
          durationMs: 100,
        });

        const found = debugSpy.calls
          .slice(before)
          .some(
            (c) => c.args[0] === "[Request] POST /admin/events/[id] 201 100ms",
          );
        expect(found).toBe(true);
      });

      test("logs error status codes", () => {
        const before = debugSpy.calls.length;
        logRequest({
          method: "GET",
          path: "/admin",
          status: 403,
          durationMs: 5,
        });

        const found = debugSpy.calls
          .slice(before)
          .some((c) => c.args[0] === "[Request] GET /admin 403 5ms");
        expect(found).toBe(true);
      });

      test("suppresses logs when TEST_SUPPRESS_REQUEST_LOGS is set", () => {
        Deno.env.set("TEST_SUPPRESS_REQUEST_LOGS", "1");
        const before = debugSpy.calls.length;

        logRequest({
          method: "POST",
          path: "/admin/login",
          status: 302,
          durationMs: 1,
        });

        const found = debugSpy.calls
          .slice(before)
          .some((c) =>
            String(c.args[0]).includes("[Request] POST /admin/login"),
          );
        expect(found).toBe(false);
      });

      test("logs normally when TEST_SUPPRESS_REQUEST_LOGS is not set", () => {
        const before = debugSpy.calls.length;
        logRequest({
          method: "POST",
          path: "/admin/login",
          status: 302,
          durationMs: 1,
        });

        const found = debugSpy.calls
          .slice(before)
          .some((c) => c.args[0] === "[Request] POST /admin/login 302 1ms");
        expect(found).toBe(true);
      });
    },
  );

  const setupErrorSpy = () => {
    let errorSpy: Spy<Console, [message?: unknown, ...args: unknown[]], void>;
    beforeEach(() => {
      errorSpy = spy(console, "error");
    });
    afterEach(() => {
      errorSpy.restore();
    });
    return {
      get calls() {
        return errorSpy.calls;
      },
    };
  };

  describe("logError", () => {
    const spyRef = setupErrorSpy();

    test("logs error code only", () => {
      const before = spyRef.calls.length;
      logError({ code: ErrorCode.DB_CONNECTION });

      const found = spyRef.calls
        .slice(before)
        .some((c) => c.args[0] === "[Error] E_DB_CONNECTION");
      expect(found).toBe(true);
    });

    test("logs error with event ID", () => {
      const before = spyRef.calls.length;
      logError({ code: ErrorCode.CAPACITY_EXCEEDED, eventId: 42 });

      const found = spyRef.calls
        .slice(before)
        .some((c) => c.args[0] === "[Error] E_CAPACITY_EXCEEDED event=42");
      expect(found).toBe(true);
    });

    test("logs error with attendee ID", () => {
      const before = spyRef.calls.length;
      logError({ code: ErrorCode.WEBHOOK_SEND, attendeeId: 99 });

      const found = spyRef.calls
        .slice(before)
        .some((c) => c.args[0] === "[Error] E_WEBHOOK_SEND attendee=99");
      expect(found).toBe(true);
    });

    test("logs error with detail", () => {
      const before = spyRef.calls.length;
      logError({ code: ErrorCode.STRIPE_SIGNATURE, detail: "mismatch" });

      const found = spyRef.calls
        .slice(before)
        .some(
          (c) => c.args[0] === '[Error] E_STRIPE_SIGNATURE detail="mismatch"',
        );
      expect(found).toBe(true);
    });

    test("logs error with all context", () => {
      const before = spyRef.calls.length;
      logError({
        code: ErrorCode.NOT_FOUND_EVENT,
        eventId: 1,
        attendeeId: 2,
        detail: "inactive",
      });

      const found = spyRef.calls
        .slice(before)
        .some(
          (c) =>
            c.args[0] ===
            '[Error] E_NOT_FOUND_EVENT event=1 attendee=2 detail="inactive"',
        );
      expect(found).toBe(true);
    });

    test("sends ntfy notification when NTFY_URL is configured", async () => {
      const restore = setTestEnv({ NTFY_URL: "https://ntfy.sh/test-topic" });
      const fetchStub = stub(globalThis, "fetch", () =>
        Promise.resolve(new Response()),
      );

      await runWithPendingWork(async () => {
        logError({ code: ErrorCode.DB_QUERY });
        await flushPendingWork();
      });

      expect(fetchStub.calls.length).toBeGreaterThanOrEqual(1);
      const ntfyCall = fetchStub.calls.find(
        (c) => c.args[0] === "https://ntfy.sh/test-topic",
      );
      expect(ntfyCall).toBeDefined();
      const options = ntfyCall!.args[1] as RequestInit;
      expect(options.body).toBe("E_DB_QUERY");

      fetchStub.restore();
      restore();
    });

    describe("activity log persistence", () => {
      beforeEach(async () => {
        await createTestDbWithSetup();
      });

      afterEach(() => {
        resetDb();
      });

      test("persists error to activity log", async () => {
        await runWithPendingWork(async () => {
          logError({
            code: ErrorCode.STRIPE_CHECKOUT,
            detail: "session creation failed",
          });
          await flushPendingWork();
        });

        const entries = await getAllActivityLog();
        const match = entries.find(
          (e) =>
            e.message ===
            "Error: Stripe checkout failed (session creation failed)",
        );
        expect(match).toBeDefined();
        expect(match!.event_id).toBeNull();
      });

      test("persists error with event ID to activity log", async () => {
        const event = await createTestEvent();
        await runWithPendingWork(async () => {
          logError({
            code: ErrorCode.PAYMENT_REFUND,
            eventId: event.id,
            detail: "refund declined",
          });
          await flushPendingWork();
        });

        const entries = await getAllActivityLog();
        const match = entries.find(
          (e) => e.message === "Error: Payment refund failed (refund declined)",
        );
        expect(match).toBeDefined();
        expect(match!.event_id).toBe(event.id);
      });

      test("persists error without detail to activity log", async () => {
        await runWithPendingWork(async () => {
          logError({ code: ErrorCode.DB_CONNECTION });
          await flushPendingWork();
        });

        const entries = await getAllActivityLog();
        const match = entries.find(
          (e) => e.message === "Error: Database connection failed",
        );
        expect(match).toBeDefined();
      });

      test("guards against recursive logError during persistence", async () => {
        // Call logError twice rapidly — the guard prevents the second from
        // persisting to the activity log while the first is still writing
        await runWithPendingWork(async () => {
          logError({ code: ErrorCode.DB_CONNECTION });
          logError({ code: ErrorCode.DB_QUERY });
          await flushPendingWork();
        });

        const entries = await getAllActivityLog();
        const connError = entries.find(
          (e) => e.message === "Error: Database connection failed",
        );
        const queryError = entries.find(
          (e) => e.message === "Error: Database query failed",
        );
        // First error persists; second is guarded (skipped) since first is still active
        expect(connError).toBeDefined();
        expect(queryError).toBeUndefined();
      });
    });
  });

  describe("logErrorLocal", () => {
    const localSpyRef = setupErrorSpy();

    test("logs error to console", () => {
      const before = localSpyRef.calls.length;
      logErrorLocal({ code: ErrorCode.DB_CONNECTION });

      const found = localSpyRef.calls
        .slice(before)
        .some((c) => c.args[0] === "[Error] E_DB_CONNECTION");
      expect(found).toBe(true);
    });

    test("logs error with all context", () => {
      const before = localSpyRef.calls.length;
      logErrorLocal({
        code: ErrorCode.CDN_REQUEST,
        eventId: 5,
        detail: "ntfy send failed",
      });

      const found = localSpyRef.calls
        .slice(before)
        .some(
          (c) =>
            c.args[0] ===
            '[Error] E_CDN_REQUEST event=5 detail="ntfy send failed"',
        );
      expect(found).toBe(true);
    });

    test("does not send ntfy notification", () => {
      const restore = setTestEnv({ NTFY_URL: "https://ntfy.sh/test-topic" });
      const fetchStub = stub(globalThis, "fetch", () =>
        Promise.resolve(new Response()),
      );

      logErrorLocal({ code: ErrorCode.DB_QUERY });

      expect(fetchStub.calls.length).toBe(0);

      fetchStub.restore();
      restore();
    });
  });

  describe("errorCodeLabel", () => {
    test("has a label for every error code", () => {
      for (const code of Object.values(ErrorCode)) {
        expect(errorCodeLabel[code as ErrorCodeType]).toBeDefined();
      }
    });
  });

  describe("formatErrorMessage", () => {
    test("formats error with detail", () => {
      const context: ErrorContext = {
        code: ErrorCode.STRIPE_CHECKOUT,
        detail: "timeout",
      };
      expect(formatErrorMessage(context)).toBe(
        "Error: Stripe checkout failed (timeout)",
      );
    });

    test("formats error without detail", () => {
      const context: ErrorContext = { code: ErrorCode.DB_CONNECTION };
      expect(formatErrorMessage(context)).toBe(
        "Error: Database connection failed",
      );
    });

    test("formats payment session error with detail", () => {
      const context: ErrorContext = {
        code: ErrorCode.PAYMENT_SESSION,
        eventId: 42,
        detail: "price mismatch",
      };
      expect(formatErrorMessage(context)).toBe(
        "Error: Payment session error (price mismatch)",
      );
    });
  });

  describe("formatRequestError", () => {
    test("formats Error instance with message", () => {
      expect(
        formatRequestError("GET", "/ticket/abc", new Error("DB timeout")),
      ).toBe("GET /ticket/[redacted]: DB timeout");
    });

    test("formats non-Error value as string", () => {
      expect(
        formatRequestError("POST", "/admin/events/5", "connection reset"),
      ).toBe("POST /admin/events/[id]: connection reset");
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
      const before = debugSpy.calls.length;
      logDebug("Setup", "Validation passed");

      const found = debugSpy.calls
        .slice(before)
        .some((c) => c.args[0] === "[Setup] Validation passed");
      expect(found).toBe(true);
    });

    test("logs with Webhook category", () => {
      const before = debugSpy.calls.length;
      logDebug("Webhook", "Sending notification");

      const found = debugSpy.calls
        .slice(before)
        .some((c) => c.args[0] === "[Webhook] Sending notification");
      expect(found).toBe(true);
    });

    test("logs with Stripe category", () => {
      const before = debugSpy.calls.length;
      logDebug("Stripe", "Creating checkout session");

      const found = debugSpy.calls
        .slice(before)
        .some((c) => c.args[0] === "[Stripe] Creating checkout session");
      expect(found).toBe(true);
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

  describeWithEnv(
    "runWithRequestId",
    { env: { TEST_SUPPRESS_REQUEST_LOGS: undefined } },
    () => {
      test("getRequestId returns ID inside request context", () => {
        runWithRequestId(() => {
          const id = getRequestId();
          expect(id).toMatch(/^[0-9a-f]{4}$/);
        });
      });

      test("getRequestId returns empty string outside request context", () => {
        expect(getRequestId()).toBe("");
      });

      test("prefixes logRequest with 4-char hex ID", () => {
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

          const expected = `[${id}] [Request] GET /admin 200 10ms`;
          const found = debugSpy.calls.some((c) => c.args[0] === expected);
          expect(found).toBe(true);
        } finally {
          debugSpy.restore();
        }
      });

      test("prefixes logError with same request ID", () => {
        const errorSpy = spy(console, "error");
        try {
          let id = "";
          runWithRequestId(() => {
            id = getRequestId();
            logRequest({
              method: "GET",
              path: "/admin",
              status: 200,
              durationMs: 5,
            });
            logError({ code: ErrorCode.DB_CONNECTION });
          });

          const expected = `[${id}] [Error] E_DB_CONNECTION`;
          const found = errorSpy.calls.some((c) => c.args[0] === expected);
          expect(found).toBe(true);
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

          const expected = `[${id}] [Setup] test message`;
          const found = debugSpy.calls.some((c) => c.args[0] === expected);
          expect(found).toBe(true);
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

        // With 65536 possible values, 10 samples should not all be identical
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

          const expected = "[Request] GET /admin 200 10ms";
          const found = debugSpy.calls.some((c) => c.args[0] === expected);
          expect(found).toBe(true);
        } finally {
          debugSpy.restore();
        }
      });
    },
  );
});
