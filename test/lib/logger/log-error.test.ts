import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { type Spy, spy, stub } from "@std/testing/mock";
import {
  bestEffort,
  ErrorCode,
  logError,
  logErrorLocal,
} from "#shared/logger.ts";
import { flushPendingWork, runWithPendingWork } from "#shared/pending-work.ts";
import {
  createTestDbWithSetup,
  createTestListing,
  getAllActivityLog,
  resetDb,
  setTestEnv,
} from "#test-utils";

/** Scoped console.error spy — call inside a describe block. */
const setupErrorSpy = () => {
  let errorSpy: Spy;
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
    lastMessage: () => errorSpy.calls.at(-1)?.args[0] as string | undefined,
  };
};

// Outer describe ensures sequential execution — createTestListing() calls
// handleRequest which sets a request-scoped ID via AsyncLocalStorage.
// Without sequential ordering, that context can leak into later blocks.
describe("log-error", () => {
  describe("logError", () => {
    const spyRef = setupErrorSpy();
    let restoreEnv: (() => void) | undefined;

    beforeEach(() => {
      restoreEnv = setTestEnv({ NTFY_URL: undefined });
    });

    afterEach(() => {
      restoreEnv?.();
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
      logError({ attendeeId: 99, code: ErrorCode.WEBHOOK_SEND });
      expect(spyRef.lastMessage()).toBe("[Error] E_WEBHOOK_SEND attendee=99");
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
      const restore = setTestEnv({ NTFY_URL: "https://ntfy.sh/test-topic" });
      const fetchStub = stub(globalThis, "fetch", () =>
        Promise.resolve(new Response()),
      );

      try {
        await runWithPendingWork(async () => {
          logError({ code: ErrorCode.DB_QUERY });
          await flushPendingWork();
        });

        const ntfyCall = fetchStub.calls.find(
          (c) => c.args[0] === "https://ntfy.sh/test-topic",
        );
        expect(ntfyCall).toBeDefined();
        expect((ntfyCall!.args[1] as RequestInit).body).toBe("E_DB_QUERY");
      } finally {
        fetchStub.restore();
        restore();
      }
    });

    test("skips ntfy and activity log outside pending work scope", () => {
      const fetchStub = stub(globalThis, "fetch", () =>
        Promise.resolve(new Response()),
      );
      const restore = setTestEnv({ NTFY_URL: "https://ntfy.sh/test-topic" });

      try {
        logError({ code: ErrorCode.DB_CONNECTION });
        expect(spyRef.lastMessage()).toBe("[Error] E_DB_CONNECTION");
        expect(fetchStub.calls.length).toBe(0);
      } finally {
        fetchStub.restore();
        restore();
      }
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

      test("guards against recursive logError during persistence", async () => {
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
        expect(queryError).toBeUndefined();
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
      const restore = setTestEnv({ NTFY_URL: "https://ntfy.sh/test-topic" });
      const fetchStub = stub(globalThis, "fetch", () =>
        Promise.resolve(new Response()),
      );

      try {
        logErrorLocal({ code: ErrorCode.DB_QUERY });
        expect(fetchStub.calls.length).toBe(0);
      } finally {
        fetchStub.restore();
        restore();
      }
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
