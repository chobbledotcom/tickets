import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import {
  addQueryLogEntry,
  enableQueryLog,
  getQueryLog,
  getQueryLogStartTime,
  isQueryLogEnabled,
  N_PLUS_ONE_THRESHOLD,
  runWithQueryLogContext,
  setN1GuardNotifyOnly,
  trackQuery,
} from "#shared/db/query-log.ts";
// Preloaded so the guard's dynamic `import("#shared/logger.ts")` is a cache hit,
// making the notify-mode test's flush deterministic rather than time-dependent.
import "#shared/logger.ts";

describe("query-log", () => {
  describe("enableQueryLog", () => {
    test("starts disabled", () => {
      runWithQueryLogContext(() => {
        expect(isQueryLogEnabled()).toBe(false);
      });
    });

    test("enableQueryLog enables tracking", () => {
      runWithQueryLogContext(() => {
        enableQueryLog();
        expect(isQueryLogEnabled()).toBe(true);
      });
    });
  });

  describe("addQueryLogEntry", () => {
    test("records entries when enabled", () => {
      runWithQueryLogContext(() => {
        enableQueryLog();
        addQueryLogEntry("SELECT 1", 1.5);
        addQueryLogEntry("SELECT 2", 2.3);
        const log = getQueryLog();
        expect(log).toHaveLength(2);
        expect(log[0]!.sql).toBe("SELECT 1");
        expect(log[0]!.durationMs).toBe(1.5);
        expect(log[1]!.sql).toBe("SELECT 2");
        expect(log[1]!.durationMs).toBe(2.3);
      });
    });

    test("ignores entries when disabled", () => {
      runWithQueryLogContext(() => {
        addQueryLogEntry("SELECT 1", 1.0);
        expect(getQueryLog()).toHaveLength(0);
      });
    });
  });

  describe("enableQueryLog resets previous entries", () => {
    test("clears log on enable", () => {
      runWithQueryLogContext(() => {
        enableQueryLog();
        addQueryLogEntry("SELECT old", 1.0);
        expect(getQueryLog()).toHaveLength(1);

        enableQueryLog();
        expect(getQueryLog()).toHaveLength(0);
      });
    });
  });

  describe("getQueryLog returns a snapshot", () => {
    test("returned array is independent of internal state", () => {
      runWithQueryLogContext(() => {
        enableQueryLog();
        addQueryLogEntry("SELECT 1", 1.0);
        const snapshot = getQueryLog();
        addQueryLogEntry("SELECT 2", 2.0);
        expect(snapshot).toHaveLength(1);
        expect(getQueryLog()).toHaveLength(2);
      });
    });
  });

  describe("getQueryLogStartTime", () => {
    test("returns 0 before logging is enabled", () => {
      runWithQueryLogContext(() => {
        expect(getQueryLogStartTime()).toBe(0);
      });
    });

    test("records start time when enableQueryLog is called", () => {
      runWithQueryLogContext(() => {
        const before = performance.now();
        enableQueryLog();
        const after = performance.now();
        const startTime = getQueryLogStartTime();
        expect(startTime).toBeGreaterThanOrEqual(before);
        expect(startTime).toBeLessThanOrEqual(after);
      });
    });

    test("resets start time on subsequent enableQueryLog calls", () => {
      runWithQueryLogContext(() => {
        enableQueryLog();
        const first = getQueryLogStartTime();
        enableQueryLog();
        const second = getQueryLogStartTime();
        expect(second).toBeGreaterThanOrEqual(first);
      });
    });
  });

  describe("N+1 read guard", () => {
    // Reset to the default (throw) after any test that switches modes.
    afterEach(() => setN1GuardNotifyOnly(null));

    test("allows a read to repeat up to the threshold", async () => {
      await runWithQueryLogContext(async () => {
        let last: unknown;
        for (let i = 0; i < N_PLUS_ONE_THRESHOLD; i++) {
          last = await trackQuery("SELECT 1", () => Promise.resolve("ok"));
        }
        expect(last).toBe("ok");
      });
    });

    test("throws when the same read crosses the threshold", async () => {
      await runWithQueryLogContext(async () => {
        for (let i = 0; i < N_PLUS_ONE_THRESHOLD; i++) {
          await trackQuery("SELECT 1", () => Promise.resolve("ok"));
        }
        await expect(
          trackQuery("SELECT 1", () => Promise.resolve("ok")),
        ).rejects.toThrow(/N\+1 query detected/);
      });
    });

    test("does not count writes toward the guard", async () => {
      await runWithQueryLogContext(async () => {
        let last: unknown;
        for (let i = 0; i < N_PLUS_ONE_THRESHOLD * 2; i++) {
          last = await trackQuery("INSERT INTO t (id) VALUES (?)", () =>
            Promise.resolve("ok"),
          );
        }
        expect(last).toBe("ok");
      });
    });

    test("counts each distinct read separately", async () => {
      await runWithQueryLogContext(async () => {
        let last: unknown;
        for (let i = 0; i < N_PLUS_ONE_THRESHOLD; i++) {
          await trackQuery("SELECT a", () => Promise.resolve("a"));
          last = await trackQuery("SELECT b", () => Promise.resolve("b"));
        }
        expect(last).toBe("b");
      });
    });

    test("does not enforce outside a request scope", async () => {
      let last: unknown;
      for (let i = 0; i <= N_PLUS_ONE_THRESHOLD; i++) {
        last = await trackQuery("SELECT 1", () => Promise.resolve("ok"));
      }
      expect(last).toBe("ok");
    });

    test("notify mode reports the violation instead of throwing", async () => {
      const errorSpy = stub(console, "error");
      setN1GuardNotifyOnly(true);
      try {
        await runWithQueryLogContext(async () => {
          let last: unknown;
          for (let i = 0; i <= N_PLUS_ONE_THRESHOLD; i++) {
            last = await trackQuery("SELECT 1", () => Promise.resolve("ok"));
          }
          expect(last).toBe("ok");
        });
        // Let the fire-and-forget dynamic import + logError settle.
        await new Promise((resolve) => setTimeout(resolve, 0));
      } finally {
        errorSpy.restore();
      }
      const reported = errorSpy.calls.some((call) =>
        call.args.some((arg) => String(arg).includes("N+1 query detected")),
      );
      expect(reported).toBe(true);
    });
  });
});
