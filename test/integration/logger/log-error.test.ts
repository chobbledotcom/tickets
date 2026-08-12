import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import {
  N_PLUS_ONE_THRESHOLD,
  runWithQueryLogContext,
  setN1GuardNotifyOnly,
  trackSql,
} from "#shared/db/query-log.ts";
import { CONFIG_KEYS, settings } from "#shared/db/settings.ts";
import {
  bestEffort,
  ErrorCode,
  errorCodeLabel,
  logError,
  logErrorLocal,
  withDeferredErrorReports,
} from "#shared/logger.ts";
import { flushPendingWork, runWithPendingWork } from "#shared/pending-work.ts";
import { getAllActivityLog } from "#test-utils/activity-log.ts";
import { createTestDbWithSetup, resetDb } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { type EnvScope, withEnv } from "#test-utils/env.ts";
import { setupErrorSpy } from "#test-utils/error-spy.ts";
import { stubFetch } from "#test-utils/fetch-stub.ts";

// Outer describe ensures sequential execution — createTestListing() calls
// handleRequest which sets a request-scoped ID via AsyncLocalStorage.
// Without sequential ordering, that context can leak into later blocks.
describe("error code table", () => {
  // Codes are persisted into the activity log and matched by admin tooling, so
  // a blanked or duplicated code would corrupt every logged error's identity.
  test("every code is E_-prefixed, unique, and labelled", () => {
    const codes = Object.values(ErrorCode);
    expect(codes.length).toBeGreaterThan(0);
    expect(new Set(codes).size).toBe(codes.length);
    for (const code of codes) {
      expect(code).toMatch(/^E_[A-Z_]+$/);
      expect(errorCodeLabel[code].length, code).toBeGreaterThan(0);
    }
  });
});

describe("log-error", () => {
  describe("logError", () => {
    const spyRef = setupErrorSpy();
    let env: EnvScope;

    beforeEach(() => {
      env = withEnv({ NTFY_URL: undefined });
    });

    afterEach(() => {
      env.dispose();
    });

    test("logs error code only", () => {
      logError({ code: ErrorCode.DB_CONNECTION });
      expect(spyRef.lastMessage()).toBe("[Error] E_DB_CONNECTION");
    });

    test("logs error with listing ID", () => {
      logError({ code: ErrorCode.CAPACITY_EXCEEDED, listingId: 42 });
      expect(spyRef.lastMessage()).toBe(
        "[Error] E_CAPACITY_EXCEEDED listing=42",
      );
    });

    test("logs error with attendee ID", () => {
      logError({ attendeeId: 99, code: ErrorCode.DB_QUERY });
      expect(spyRef.lastMessage()).toBe("[Error] E_DB_QUERY attendee=99");
    });

    test("logs error with detail", () => {
      logError({ code: ErrorCode.STRIPE_SIGNATURE, detail: "mismatch" });
      expect(spyRef.lastMessage()).toBe(
        '[Error] E_STRIPE_SIGNATURE detail="mismatch"',
      );
    });

    test("logs error with all context fields", () => {
      logError({
        attendeeId: 2,
        code: ErrorCode.NOT_FOUND_LISTING,
        detail: "inactive",
        listingId: 1,
      });
      expect(spyRef.lastMessage()).toBe(
        '[Error] E_NOT_FOUND_LISTING listing=1 attendee=2 detail="inactive"',
      );
    });

    test("sends ntfy notification when NTFY_URL is configured", async () => {
      using _env = withEnv({ NTFY_URL: "https://ntfy.sh/test-topic" });
      using fetchStub = stubFetch(new Response());

      await runWithPendingWork(async () => {
        logError({ code: ErrorCode.DB_QUERY });
        await flushPendingWork();
      });

      const ntfyCall = fetchStub.calls.find(
        (c) => c.args[0] === "https://ntfy.sh/test-topic",
      );
      expect(ntfyCall).toBeDefined();
      expect((ntfyCall!.args[1] as RequestInit).body).toBe("E_DB_QUERY");
    });

    test("skips ntfy and activity log outside pending work scope", () => {
      using fetchStub = stubFetch(new Response());
      using _env = withEnv({ NTFY_URL: "https://ntfy.sh/test-topic" });

      logError({ code: ErrorCode.DB_CONNECTION });
      expect(spyRef.lastMessage()).toBe("[Error] E_DB_CONNECTION");
      expect(fetchStub.calls.length).toBe(0);
    });

    test("defers fan-out until critical work has unwound", async () => {
      using _env = withEnv({ NTFY_URL: "https://ntfy.sh/test-topic" });
      using fetchStub = stubFetch(new Response());
      const steps: string[] = [];

      await runWithPendingWork(async () => {
        await withDeferredErrorReports(async () => {
          logError({ code: ErrorCode.PAYMENT_REFUND });
          steps.push(`work:${fetchStub.calls.length}`);
        });
        steps.push(`unwound:${fetchStub.calls.length}`);
        await flushPendingWork();
      });

      expect(steps).toEqual(["work:0", "unwound:1"]);
    });

    test("nested deferred scopes share the outer boundary", async () => {
      using _env = withEnv({ NTFY_URL: "https://ntfy.sh/test-topic" });
      using fetchStub = stubFetch(new Response());

      await runWithPendingWork(async () => {
        await withDeferredErrorReports(async () => {
          await withDeferredErrorReports(async () => {
            logError({ code: ErrorCode.PAYMENT_REFUND });
          });
          expect(fetchStub.calls).toHaveLength(0);
        });
        expect(fetchStub.calls).toHaveLength(1);
        await flushPendingWork();
      });
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
        expect(match!.listing_id).toBeNull();
      });

      test("persists error with listing ID to activity log", async () => {
        const listing = await createTestListing();
        await runWithPendingWork(async () => {
          logError({
            code: ErrorCode.PAYMENT_REFUND,
            detail: "refund declined",
            listingId: listing.id,
          });
          await flushPendingWork();
        });

        const entries = await getAllActivityLog();
        const match = entries.find(
          (e) => e.message === "Error: Payment refund failed (refund declined)",
        );
        expect(match).toBeDefined();
        expect(match!.listing_id).toBe(listing.id);
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

      test("persists every independent error in one request", async () => {
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
        expect(connError).toBeDefined();
        expect(queryError).toBeDefined();
      });

      test("does not persist an error raised by error persistence", async () => {
        const settingsRead = "SELECT key, value FROM settings WHERE key IN (?)";
        setN1GuardNotifyOnly(true);
        try {
          await runWithPendingWork(() =>
            runWithQueryLogContext(async () => {
              for (let count = 0; count < N_PLUS_ONE_THRESHOLD; count++) {
                await trackSql(settingsRead, () => Promise.resolve());
              }
              settings.invalidateCache();
              logError({ code: ErrorCode.DB_CONNECTION });
            })
          );
        } finally {
          setN1GuardNotifyOnly(null);
        }

        await settings.loadKeys([CONFIG_KEYS.WRAPPED_PRIVATE_KEY]);
        const messages = (await getAllActivityLog()).map(({ message }) =>
          message
        );
        expect(messages).toContain("Error: Database connection failed");
        expect(messages.some((message) => message.includes("N+1 query")))
          .toBe(false);
      });

      test("flushes every deferred error when critical work throws", async () => {
        const failure = new Error("critical refund work failed");
        let caught: unknown;
        try {
          await runWithPendingWork(() =>
            withDeferredErrorReports(async () => {
              logError({ code: ErrorCode.DB_CONNECTION });
              logError({ code: ErrorCode.DB_QUERY });
              throw failure;
            })
          );
        } catch (error) {
          caught = error;
        }

        expect(caught).toBe(failure);
        const messages = (await getAllActivityLog()).map(({ message }) =>
          message
        );
        expect(messages).toContain("Error: Database connection failed");
        expect(messages).toContain("Error: Database query failed");
      });
    });
  });

  describe("logErrorLocal", () => {
    const spyRef = setupErrorSpy();

    test("logs error to console", () => {
      logErrorLocal({ code: ErrorCode.DB_CONNECTION });
      expect(spyRef.lastMessage()).toBe("[Error] E_DB_CONNECTION");
    });

    test("logs error with all context fields", () => {
      logErrorLocal({
        code: ErrorCode.CDN_REQUEST,
        detail: "ntfy send failed",
        listingId: 5,
      });
      expect(spyRef.lastMessage()).toBe(
        '[Error] E_CDN_REQUEST listing=5 detail="ntfy send failed"',
      );
    });

    test("does not send ntfy notification", () => {
      using _env = withEnv({ NTFY_URL: "https://ntfy.sh/test-topic" });
      using fetchStub = stubFetch(new Response());

      logErrorLocal({ code: ErrorCode.DB_QUERY });
      expect(fetchStub.calls.length).toBe(0);
    });
  });

  describe("bestEffort", () => {
    const spyRef = setupErrorSpy();

    test("runs the operation and logs nothing on success", async () => {
      let ran = false;
      await bestEffort("stats write", async () => {
        ran = true;
      });
      expect(ran).toBe(true);
      expect(spyRef.calls.length).toBe(0);
    });

    test("logs the failure under DB_QUERY and does not rethrow", async () => {
      // Resolves rather than throwing, so the critical caller carries on.
      await bestEffort("stats write", async () => {
        throw new Error("blob corrupt");
      });
      expect(spyRef.lastMessage()).toBe(
        '[Error] E_DB_QUERY detail="stats write: Error: blob corrupt"',
      );
    });
  });
});
