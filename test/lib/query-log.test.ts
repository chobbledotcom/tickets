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
  sqlWallClockMs,
  trackQuery,
} from "#shared/db/query-log.ts";
// Importing logger eagerly also preloads it, so the dynamic
// `import("#shared/logger.ts")` in the N+1 guard and the SQL system-log
// mirror is a cache hit — keeping their fire-and-forget flush deterministic
// rather than time-dependent.
import { setSuppressDebugLogs } from "#shared/logger.ts";

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
        addQueryLogEntry("SELECT 1", 1.5, 100);
        addQueryLogEntry("SELECT 2", 2.3, 200);
        const log = getQueryLog();
        expect(log).toHaveLength(2);
        expect(log[0]!.sql).toBe("SELECT 1");
        expect(log[0]!.durationMs).toBe(1.5);
        expect(log[1]!.sql).toBe("SELECT 2");
        expect(log[1]!.durationMs).toBe(2.3);
      });
    });

    test("records the query start time for wall-clock math", () => {
      runWithQueryLogContext(() => {
        enableQueryLog();
        addQueryLogEntry("SELECT 1", 1.5, 100);
        expect(getQueryLog()[0]!.startedAtMs).toBe(100);
      });
    });

    test("ignores entries when disabled", () => {
      runWithQueryLogContext(() => {
        addQueryLogEntry("SELECT 1", 1.0, 0);
        expect(getQueryLog()).toHaveLength(0);
      });
    });
  });

  describe("enableQueryLog resets previous entries", () => {
    test("clears log on enable", () => {
      runWithQueryLogContext(() => {
        enableQueryLog();
        addQueryLogEntry("SELECT old", 1.0, 0);
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
        addQueryLogEntry("SELECT 1", 1.0, 0);
        const snapshot = getQueryLog();
        addQueryLogEntry("SELECT 2", 2.0, 1);
        expect(snapshot).toHaveLength(1);
        expect(getQueryLog()).toHaveLength(2);
      });
    });
  });

  describe("sqlWallClockMs", () => {
    const entry = (
      startedAtMs: number,
      durationMs: number,
    ): {
      sql: string;
      durationMs: number;
      startedAtMs: number;
    } => ({ durationMs, sql: "SELECT 1", startedAtMs });

    test("is zero with no queries", () => {
      expect(sqlWallClockMs([])).toBe(0);
    });

    test("equals the duration of a single query", () => {
      expect(sqlWallClockMs([entry(100, 5)])).toBe(5);
    });

    test("sums durations of disjoint (sequential) queries", () => {
      // [100,105] then [200,210] never overlap → 5 + 10.
      expect(sqlWallClockMs([entry(100, 5), entry(200, 10)])).toBe(15);
    });

    test("counts overlapping (concurrent) time only once", () => {
      // [100,110] and [105,115] overlap → union is [100,115] = 15ms,
      // not the 20ms a naive sum of durations would report.
      expect(sqlWallClockMs([entry(100, 10), entry(105, 10)])).toBe(15);
    });

    test("counts one query fully contained in another only once", () => {
      // [100,120] contains [105,110] → union stays 20ms.
      expect(sqlWallClockMs([entry(100, 20), entry(105, 5)])).toBe(20);
    });

    test("counts a shared batch round-trip window once", () => {
      // Batch statements share one [start, start+elapsed] window.
      const batch = [entry(100, 10), entry(100, 10), entry(100, 10)];
      expect(sqlWallClockMs(batch)).toBe(10);
    });

    test("merges intervals regardless of insertion order", () => {
      // Entries are appended in completion order, so the helper must sort.
      expect(sqlWallClockMs([entry(200, 10), entry(100, 5)])).toBe(15);
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

  describe("trackQuery recording", () => {
    test("records duration and start time when logging is enabled", async () => {
      await runWithQueryLogContext(async () => {
        enableQueryLog();
        const before = performance.now();
        await trackQuery("SELECT 1", () => Promise.resolve("ok"));
        const after = performance.now();
        const [logged] = getQueryLog();
        expect(logged!.sql).toBe("SELECT 1");
        expect(logged!.startedAtMs).toBeGreaterThanOrEqual(before);
        expect(logged!.startedAtMs).toBeLessThanOrEqual(after);
        expect(logged!.durationMs).toBeGreaterThanOrEqual(0);
      });
    });
  });

  describe("system-log mirroring", () => {
    // A completed query is mirrored to the system logs via console.debug; let the
    // fire-and-forget dynamic import + logDebug settle before asserting.
    const captureSqlLogs = async (
      run: () => Promise<unknown>,
    ): Promise<string[]> => {
      setSuppressDebugLogs(false);
      const debugSpy = stub(console, "debug");
      try {
        await run();
        await new Promise((resolve) => setTimeout(resolve, 0));
        return debugSpy.calls.map((call) => call.args.join(" "));
      } finally {
        debugSpy.restore();
        setSuppressDebugLogs(null);
      }
    };

    test("mirrors a completed statement, omitting bound values", async () => {
      const logs = await captureSqlLogs(() =>
        trackQuery("SELECT name FROM users WHERE id = ?", () =>
          Promise.resolve("ok"),
        ),
      );
      expect(
        logs.some((line) =>
          line.includes("[SQL] SELECT name FROM users WHERE id = ?"),
        ),
      ).toBe(true);
    });

    test("collapses whitespace so a multi-line statement logs on one line", async () => {
      const logs = await captureSqlLogs(() =>
        trackQuery("SELECT\n  id\nFROM   users", () => Promise.resolve("ok")),
      );
      expect(
        logs.some((line) => line.includes("[SQL] SELECT id FROM users")),
      ).toBe(true);
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
