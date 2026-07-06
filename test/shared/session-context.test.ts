import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { AuthSession } from "#routes/auth.ts";
import {
  getCachedSession,
  runWithSessionContext,
  setCachedSession,
} from "#shared/session-context.ts";

const makeSession = (token = "tok"): AuthSession => ({
  adminLevel: "owner",
  token,
  userId: 1,
  wrappedDataKey: null,
});

describe("session-context", () => {
  describe("getCachedSession", () => {
    test("returns undefined outside a context", () => {
      expect(getCachedSession()).toBeUndefined();
    });

    test("returns undefined before session is resolved", () => {
      runWithSessionContext(() => {
        expect(getCachedSession()).toBeUndefined();
      });
    });

    test("returns null after caching null", () => {
      runWithSessionContext(() => {
        setCachedSession(null);
        expect(getCachedSession()).toBeNull();
      });
    });

    test("returns session after caching a session", () => {
      const session = makeSession();
      runWithSessionContext(() => {
        setCachedSession(session);
        expect(getCachedSession()).toBe(session);
      });
    });
  });

  describe("setCachedSession", () => {
    test("is a no-op outside a context", () => {
      setCachedSession(makeSession());
      expect(getCachedSession()).toBeUndefined();
    });
  });

  describe("runWithSessionContext", () => {
    test("isolates contexts between nested runs", () => {
      const outer = makeSession("outer");
      const inner = makeSession("inner");

      runWithSessionContext(() => {
        setCachedSession(outer);

        runWithSessionContext(() => {
          expect(getCachedSession()).toBeUndefined();
          setCachedSession(inner);
          expect(getCachedSession()!.token).toBe("inner");
        });

        expect(getCachedSession()!.token).toBe("outer");
      });
    });

    test("returns the value from the wrapped function", () => {
      const result = runWithSessionContext(() => 42);
      expect(result).toBe(42);
    });

    test("isolates concurrent async flows that interleave their awaits", async () => {
      // The security-critical property: two requests in flight at once must each
      // only ever see their own session, even when their awaits interleave on
      // the event loop. A leak here would let one request read another's
      // session (and thus derive another user's private key).
      const flow = (token: string, delayMs: number): Promise<string> =>
        runWithSessionContext(async () => {
          setCachedSession(makeSession(token));
          // Yield control so the other flow runs between setup and read.
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          return getCachedSession()!.token;
        });

      const [first, second] = await Promise.all([
        flow("request-a", 10),
        flow("request-b", 1),
      ]);

      expect(first).toBe("request-a");
      expect(second).toBe("request-b");
    });
  });
});
