import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { returnsNext, stub } from "@std/testing/mock";
import {
  countDatabaseRoundTrip,
  enableFooterDebug,
  enableQueryLog,
  enforceTransactionRoundTripGuard,
  getQueryLog,
  getQueryLogStartTime,
  isFooterDebugEnabled,
  N_PLUS_ONE_THRESHOLD,
  runWithQueryLogContext,
  setN1GuardNotifyOnly,
  sqlWallClockMs,
  TRANSACTION_ROUNDTRIP_THRESHOLD,
  trackSql,
} from "#shared/db/query-log.ts";
// Importing logger eagerly also preloads it, so the dynamic
// `import("#shared/logger.ts")` in the N+1 guard and the SQL system-log
// mirror is a cache hit — keeping their fire-and-forget flush deterministic
// rather than time-dependent.
import { setSuppressDebugLogs } from "#shared/log-settings.ts";
import { BUNNY_SUBREQUEST_LIMIT } from "#shared/subrequest-budget.ts";

describe("query-log", () => {
  describe("enableQueryLog resets previous entries", () => {
    test("clears log on enable", async () => {
      await runWithQueryLogContext(async () => {
        enableQueryLog();
        await trackSql("SELECT old", () => Promise.resolve());
        expect(getQueryLog()).toHaveLength(1);

        enableQueryLog();
        expect(getQueryLog()).toHaveLength(0);
      });
    });
  });

  describe("getQueryLog returns a snapshot", () => {
    test("returned array is independent of internal state", async () => {
      await runWithQueryLogContext(async () => {
        enableQueryLog();
        await trackSql("SELECT 1", () => Promise.resolve());
        const snapshot = getQueryLog();
        await trackSql("SELECT 2", () => Promise.resolve());
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
    test("returns 0 before logging is enabled", async () => {
      await runWithQueryLogContext(async () => {
        expect(getQueryLogStartTime()).toBe(0);
      });
    });

    test("records start time when enableQueryLog is called", async () => {
      await runWithQueryLogContext(async () => {
        const before = performance.now();
        enableQueryLog();
        const after = performance.now();
        const startTime = getQueryLogStartTime();
        expect(startTime).toBeGreaterThanOrEqual(before);
        expect(startTime).toBeLessThanOrEqual(after);
      });
    });

    test("resets start time on subsequent enableQueryLog calls", async () => {
      await runWithQueryLogContext(async () => {
        enableQueryLog();
        const first = getQueryLogStartTime();
        enableQueryLog();
        const second = getQueryLogStartTime();
        expect(second).toBeGreaterThanOrEqual(first);
      });
    });

    test("each enable assigns the fresh clock value, never accumulates it", async () => {
      // Stubbing the clock pins the exact value the second enable must store:
      // a re-assignment yields 2000, whereas an accumulating `+=` would carry
      // the first reading forward to 3000.
      await runWithQueryLogContext(async () => {
        const nowStub = stub(performance, "now", returnsNext([1000, 2000]));
        try {
          enableQueryLog();
          expect(getQueryLogStartTime()).toBe(1000);
          enableQueryLog();
          expect(getQueryLogStartTime()).toBe(2000);
        } finally {
          nowStub.restore();
        }
      });
    });
  });

  describe("footer debug visibility", () => {
    test("is hidden by default and shown only after enableFooterDebug", async () => {
      // A fresh request context must not expose the staff-only debug footer
      // (default `false`); enabling it flips the flag to exactly `true`.
      await runWithQueryLogContext(async () => {
        expect(isFooterDebugEnabled()).toBe(false);
        enableFooterDebug();
        expect(isFooterDebugEnabled()).toBe(true);
      });
    });
  });

  describe("trackSql recording", () => {
    test("records duration and start time when logging is enabled", async () => {
      await runWithQueryLogContext(async () => {
        enableQueryLog();
        const before = performance.now();
        await trackSql("SELECT 1", () => Promise.resolve("ok"));
        const after = performance.now();
        const [logged] = getQueryLog();
        expect(logged!.sql).toBe("SELECT 1");
        expect(logged!.startedAtMs).toBeGreaterThanOrEqual(before);
        expect(logged!.startedAtMs).toBeLessThanOrEqual(after);
        expect(logged!.durationMs).toBeGreaterThanOrEqual(0);
      });
    });

    test("records the elapsed difference, not a ratio, of the clock readings", async () => {
      // Pin the start/end clock readings so the recorded duration is the exact
      // subtraction (1005 - 1000 = 5). A `now() / start` regression would log
      // ~1.005 instead, so the precise value guards the arithmetic.
      await runWithQueryLogContext(async () => {
        enableQueryLog();
        const nowStub = stub(performance, "now", returnsNext([1000, 1005]));
        try {
          await trackSql("SELECT 1", () => Promise.resolve("ok"));
        } finally {
          nowStub.restore();
        }
        const [logged] = getQueryLog();
        expect(logged!.startedAtMs).toBe(1000);
        expect(logged!.durationMs).toBe(5);
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
        trackSql("SELECT name FROM users WHERE id = ?", () =>
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
        trackSql("SELECT\n  id\nFROM   users", () => Promise.resolve("ok")),
      );
      expect(
        logs.some((line) => line.includes("[SQL] SELECT id FROM users")),
      ).toBe(true);
    });
  });

  describe("N+1 read guard", () => {
    // Reset to the default (throw) after any test that switches modes.
    afterEach(() => setN1GuardNotifyOnly(null));

    const readSelectOne = async (count: number): Promise<unknown> => {
      let last: unknown;
      for (let i = 0; i < count; i++) {
        last = await trackSql("SELECT 1", () => Promise.resolve("ok"));
      }
      return last;
    };

    test("allows a read to repeat up to the threshold", async () => {
      await runWithQueryLogContext(async () => {
        expect(await readSelectOne(N_PLUS_ONE_THRESHOLD)).toBe("ok");
      });
    });

    test("throws when the same read crosses the threshold", async () => {
      await runWithQueryLogContext(async () => {
        for (let i = 0; i < N_PLUS_ONE_THRESHOLD; i++) {
          await trackSql("SELECT 1", () => Promise.resolve("ok"));
        }
        await expect(
          trackSql("SELECT 1", () => Promise.resolve("ok")),
        ).rejects.toThrow(/N\+1 query detected/);
      });
    });

    test("does not count writes toward the guard", async () => {
      await runWithQueryLogContext(async () => {
        let last: unknown;
        for (let i = 0; i < N_PLUS_ONE_THRESHOLD * 2; i++) {
          last = await trackSql("INSERT INTO t (id) VALUES (?)", () =>
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
          await trackSql("SELECT a", () => Promise.resolve("a"));
          last = await trackSql("SELECT b", () => Promise.resolve("b"));
        }
        expect(last).toBe("b");
      });
    });

    test("does not enforce outside a request scope", async () => {
      expect(await readSelectOne(N_PLUS_ONE_THRESHOLD + 1)).toBe("ok");
    });

    test("does not count reads that inherit a finished request's context", async () => {
      // A continuation registered inside a request keeps the request's async
      // context when it runs later — the runtime can hand that context to work
      // that starts long after the request finished (observed after a forced
      // GC at a test boundary). Reads made there must count as "outside a
      // request", so a dead request's counter can never absorb them and fire.
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let afterRequest!: Promise<unknown>;
      await runWithQueryLogContext(async () => {
        afterRequest = (async () => {
          await gate;
          return readSelectOne(N_PLUS_ONE_THRESHOLD + 1);
        })();
      });
      release();
      expect(await afterRequest).toBe("ok"); // must not throw N+1
    });

    test("notify mode reports the violation instead of throwing", async () => {
      const errorSpy = stub(console, "error");
      setN1GuardNotifyOnly(true);
      try {
        await runWithQueryLogContext(async () => {
          expect(await readSelectOne(N_PLUS_ONE_THRESHOLD + 1)).toBe("ok");
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

  describe("database round-trip guard", () => {
    const countRoundTrips = (count: number, operation = "test"): void => {
      for (let current = 0; current < count; current++) {
        countDatabaseRoundTrip(operation);
      }
    };

    test("allows exactly the Bunny subrequest limit", async () => {
      await runWithQueryLogContext(async () => {
        expect(() => countRoundTrips(BUNNY_SUBREQUEST_LIMIT)).not.toThrow();
      });
    });

    test("blocks every call beyond the Bunny subrequest limit", async () => {
      await runWithQueryLogContext(async () => {
        countRoundTrips(BUNNY_SUBREQUEST_LIMIT);
        expect(() => countDatabaseRoundTrip("call 51")).toThrow(
          /51 calls.*limit 50.*call 51/,
        );
        expect(() => countDatabaseRoundTrip("call 52")).toThrow(
          /52 calls.*limit 50.*call 52/,
        );
      });
    });

    test("starts a fresh count for each request", async () => {
      const fillBudget = (): void => countRoundTrips(BUNNY_SUBREQUEST_LIMIT);
      await runWithQueryLogContext(fillBudget);
      expect(() => runWithQueryLogContext(fillBudget)).not.toThrow();
    });

    test("does not restrict database work outside a request", () => {
      expect(() =>
        countRoundTrips(BUNNY_SUBREQUEST_LIMIT + 1, "startup"),
      ).not.toThrow();
    });
  });

  describe("transaction round-trip guard", () => {
    afterEach(() => setN1GuardNotifyOnly(null));

    test("allows up to the threshold of statements in a transaction", async () => {
      await runWithQueryLogContext(async () => {
        for (let i = 1; i <= TRANSACTION_ROUNDTRIP_THRESHOLD; i++) {
          enforceTransactionRoundTripGuard(i, "INSERT INTO t VALUES (1)");
        }
      });
    });

    test("throws when a transaction crosses the threshold", async () => {
      await runWithQueryLogContext(async () => {
        expect(() =>
          enforceTransactionRoundTripGuard(
            TRANSACTION_ROUNDTRIP_THRESHOLD + 1,
            "INSERT INTO t VALUES (1)",
          ),
        ).toThrow(/Interactive transaction too chatty/);
      });
    });

    test("fires once: counts past the crossing point are a no-op", async () => {
      await runWithQueryLogContext(async () => {
        expect(() =>
          enforceTransactionRoundTripGuard(
            TRANSACTION_ROUNDTRIP_THRESHOLD + 2,
            "INSERT INTO t VALUES (1)",
          ),
        ).not.toThrow();
      });
    });

    test("does not enforce outside a request scope (migrations exempt)", () => {
      // No runWithQueryLogContext: a startup migration rebuilding a table in one
      // big transaction must not trip the guard.
      enforceTransactionRoundTripGuard(
        TRANSACTION_ROUNDTRIP_THRESHOLD + 1,
        "CREATE TABLE t (x)",
      );
    });

    test("notify mode reports the violation instead of throwing", async () => {
      const errorSpy = stub(console, "error");
      setN1GuardNotifyOnly(true);
      try {
        await runWithQueryLogContext(async () => {
          enforceTransactionRoundTripGuard(
            TRANSACTION_ROUNDTRIP_THRESHOLD + 1,
            "INSERT INTO t VALUES (1)",
          );
          // Let the fire-and-forget dynamic import + logError settle.
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
      } finally {
        errorSpy.restore();
      }
      const reported = errorSpy.calls.some((call) =>
        call.args.some((arg) =>
          String(arg).includes("Interactive transaction too chatty"),
        ),
      );
      expect(reported).toBe(true);
    });
  });
});
