import { describe, it as test } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  getCachedSession,
  runWithSessionContext,
  setCachedSession,
} from "#lib/session-context.ts";
import type { AuthSession } from "#routes/utils.ts";

const makeSession = (token = "tok"): AuthSession => ({
  token,
  wrappedDataKey: null,
  userId: 1,
  adminLevel: "owner",
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
  });
});
