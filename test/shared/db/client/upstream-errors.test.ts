import { type Client, LibsqlError, type ResultSet } from "@libsql/client";
import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { FakeTime } from "@std/testing/time";
import {
  execute,
  executeBatch,
  executeBatchWithoutCacheInvalidation,
  queryBatch,
  queryBatchPrimary,
  type SqlStatement,
  setDb,
} from "#shared/db/client.ts";
import { MIGRATION_IDS } from "#shared/db/migrations/registry.ts";
import {
  initDb,
  invalidateInitDbCache,
  LATEST_UPDATE,
  SCHEMA_HASH,
} from "#shared/db/migrations.ts";
import { expectFullBackoffWalk } from "#test-utils/backoff-walk.ts";
import { emptyResultSet } from "#test-utils/db-helpers/result-set.ts";

/**
 * The transient upstream retry: the libsql server itself occasionally answers
 * a round trip with a fleeting HTTP failure. The client surfaces BunnyDB 421
 * and Turso 502/503/504 responses as a SERVER_ERROR naming the status. Those
 * retry on the shared 50/150/350ms backoff — but only on reads: the same response
 * on a write may arrive after it landed server-side, and replaying it would
 * double-apply, so writes (and the transactions that hold them) are not retried
 * for upstream errors. A hiccup that outlasts the retries rethrows the original
 * error (a sustained outage should still reach the error log), unlike an
 * exhausted write lock which becomes DatabaseBusyError. SQLITE_BUSY is always
 * safe to retry — the lock was never taken, so nothing ran. Any other failure —
 * a non-transient status, a non-SERVER_ERROR code, or a plain Error with a
 * lookalike message — fails immediately without a retry.
 */
describe("db > client transient upstream retry", () => {
  const upstreamError = (status: number): LibsqlError =>
    new LibsqlError(`Server returned HTTP status ${status}`, "SERVER_ERROR");
  const clientWith = (run: () => Promise<ResultSet>): Client =>
    ({ execute: run }) as unknown as Client;
  const clientWithBatch = (run: () => Promise<ResultSet[]>): Client =>
    ({ batch: run }) as unknown as Client;

  afterEach(() => {
    invalidateInitDbCache();
    setDb(null);
  });

  for (const status of [421, 502, 503, 504]) {
    test(`a fleeting upstream ${status} retries and succeeds`, async () => {
      using time = new FakeTime();
      let attempts = 0;
      setDb(
        clientWith(() => {
          attempts++;
          return attempts === 1
            ? Promise.reject(upstreamError(status))
            : Promise.resolve(emptyResultSet());
        }),
      );
      const promise = execute("SELECT 1");
      await time.tickAsync(50);
      const result = await promise;
      expect(result.rowsAffected).toBe(0);
      expect(attempts).toBe(2);
    });
  }

  test("a fleeting upstream 421 on a write is not retried", async () => {
    let attempts = 0;
    setDb(
      clientWith(() => {
        attempts++;
        return Promise.reject(upstreamError(421));
      }),
    );
    await expect(execute("INSERT INTO t (x) VALUES (1)")).rejects.toThrow(
      "SERVER_ERROR: Server returned HTTP status 421",
    );
    expect(attempts).toBe(1);
  });

  test("initDb retries a fleeting 421 on its initial schema probe", async () => {
    using time = new FakeTime();
    let attempts = 0;
    setDb(
      clientWith(() => {
        attempts++;
        return attempts === 1
          ? Promise.reject(upstreamError(421))
          : Promise.resolve({
              ...emptyResultSet(),
              rows: [
                { key: "latest_db_update", value: LATEST_UPDATE },
                { key: "db_schema_hash", value: SCHEMA_HASH },
                {
                  key: "applied_migrations",
                  value: String(MIGRATION_IDS.length),
                },
              ] as unknown as ResultSet["rows"],
            });
      }),
    );
    const initialized = initDb();
    await time.tickAsync(50);
    await initialized;
    expect(attempts).toBe(2);
  });

  test("a remote database exhausts its retries and rethrows the original error", () => {
    const failure = upstreamError(504);
    // Identity: the original error propagates unswapped — a sustained outage
    // is reported as itself, not disguised as write-lock contention.
    return expectFullBackoffWalk({
      dbUrl: "libsql://upstream-ladder.example.turso.io",
      failsWith: () => failure,
      outcome: (operation) => expect(operation).rejects.toBe(failure),
      sql: "SELECT 1",
      waits: [50, 150, 350],
    });
  });

  test("a file database exhausts its longer ladder and rethrows the original error", () => {
    const failure = upstreamError(504);
    return expectFullBackoffWalk({
      dbUrl: "file:/tmp/upstream-ladder.db",
      failsWith: () => failure,
      outcome: (operation) => expect(operation).rejects.toBe(failure),
      sql: "SELECT 1",
      waits: [50, 150, 350, 700, 1400],
    });
  });

  test("a non-transient upstream status is not retried", async () => {
    let attempts = 0;
    setDb(
      clientWith(() => {
        attempts++;
        return Promise.reject(upstreamError(500));
      }),
    );
    await expect(execute("SELECT 1")).rejects.toThrow(
      "SERVER_ERROR: Server returned HTTP status 500",
    );
    expect(attempts).toBe(1);
  });

  test("a SERVER_ERROR-shaped message on a plain Error is not retried", async () => {
    let attempts = 0;
    setDb(
      clientWith(() => {
        attempts++;
        return Promise.reject(
          new Error("SERVER_ERROR: Server returned HTTP status 504"),
        );
      }),
    );
    await expect(execute("SELECT 1")).rejects.toThrow(
      "SERVER_ERROR: Server returned HTTP status 504",
    );
    expect(attempts).toBe(1);
  });

  test("a non-SERVER_ERROR libsql failure is not retried", async () => {
    let attempts = 0;
    setDb(
      clientWith(() => {
        attempts++;
        return Promise.reject(
          new LibsqlError("bad pipeline", "HRANA_PROTO_ERROR"),
        );
      }),
    );
    await expect(execute("SELECT 1")).rejects.toThrow(
      "HRANA_PROTO_ERROR: bad pipeline",
    );
    expect(attempts).toBe(1);
  });

  for (const [label, sql] of [
    ["a write statement", "INSERT INTO t (x) VALUES (1)"],
    ["a CTE-led INSERT", "WITH x AS (SELECT 1) INSERT INTO t SELECT * FROM x"],
    ["a CTE-led UPDATE", "WITH x AS (SELECT 1) UPDATE t SET a = ?"],
    ["a CTE-led DELETE", "WITH x AS (SELECT 1) DELETE FROM t USING x"],
    [
      "a CTE-led REPLACE",
      "WITH x AS (SELECT 1) REPLACE INTO t SELECT * FROM x",
    ],
    ["a CREATE TABLE", "CREATE TABLE t (id INTEGER)"],
    ["an ALTER TABLE", "ALTER TABLE t ADD COLUMN x INTEGER"],
    ["a DROP TABLE", "DROP TABLE t"],
    ["a PRAGMA", "PRAGMA table_info(t)"],
  ] as const) {
    test(`a fleeting upstream 504 on ${label} is not retried`, async () => {
      // An upstream HTTP failure on anything but a read may arrive after its
      // side effects committed; replaying it could double-apply, so
      // only positively recognized SELECTs retry upstream errors. Every
      // CTE-led write — INSERT, UPDATE, DELETE, or REPLACE — is a write: the
      // CTE prefix must not trip the read-only retry gate. DDL and PRAGMA
      // statements are no more reads than writes are, so they fail closed the
      // same way.
      let attempts = 0;
      setDb(
        clientWith(() => {
          attempts++;
          return Promise.reject(upstreamError(504));
        }),
      );
      await expect(execute(sql)).rejects.toThrow(
        "SERVER_ERROR: Server returned HTTP status 504",
      );
      expect(attempts).toBe(1);
    });
  }

  test("a fleeting upstream 504 on a CTE-led SELECT retries and succeeds", async () => {
    // The CTE prefix must not hide a read either: a WITH ... SELECT is a
    // side-effect-free read, so it takes the upstream retry like a bare one.
    using time = new FakeTime();
    let attempts = 0;
    setDb(
      clientWith(() => {
        attempts++;
        return attempts === 1
          ? Promise.reject(upstreamError(504))
          : Promise.resolve(emptyResultSet());
      }),
    );
    const promise = execute("WITH x AS (SELECT 1) SELECT * FROM x");
    await time.tickAsync(50);
    const result = await promise;
    expect(result.rowsAffected).toBe(0);
    expect(attempts).toBe(2);
  });

  for (const [label, statements] of [
    ["a write batch", [{ args: [], sql: "INSERT INTO t (x) VALUES (1)" }]],
    [
      "a mixed read/write batch",
      [
        { args: [], sql: "SELECT 1" },
        { args: [], sql: "INSERT INTO t (x) VALUES (1)" },
      ],
    ],
  ] as [string, SqlStatement[]][]) {
    test(`a fleeting upstream 504 on ${label} is not retried`, async () => {
      let attempts = 0;
      setDb(
        clientWithBatch(() => {
          attempts++;
          return Promise.reject(upstreamError(504));
        }),
      );
      await expect(executeBatch(statements)).rejects.toThrow(
        "SERVER_ERROR: Server returned HTTP status 504",
      );
      expect(attempts).toBe(1);
    });
  }

  test("a write batch without cache invalidation is not retried on a 504", async () => {
    let attempts = 0;
    setDb(
      clientWithBatch(() => {
        attempts++;
        return Promise.reject(upstreamError(504));
      }),
    );
    await expect(
      executeBatchWithoutCacheInvalidation([
        { args: [], sql: "INSERT INTO settings (key) VALUES ('marker')" },
      ]),
    ).rejects.toThrow("SERVER_ERROR: Server returned HTTP status 504");
    expect(attempts).toBe(1);
  });

  for (const [label, batch] of [
    ["queryBatch", queryBatch],
    ["queryBatchPrimary", queryBatchPrimary],
  ] as const) {
    test(`a ${label} read batch retries on a 504 and succeeds`, async () => {
      using time = new FakeTime();
      let attempts = 0;
      setDb(
        clientWithBatch(() => {
          attempts++;
          return attempts === 1
            ? Promise.reject(upstreamError(504))
            : Promise.resolve([emptyResultSet()]);
        }),
      );
      const promise = batch([{ args: [], sql: "SELECT 1" }]);
      await time.tickAsync(50);
      const result = await promise;
      expect(result).toHaveLength(1);
      expect(attempts).toBe(2);
    });

    test(`a ${label} batch holding a write is rejected before it runs`, async () => {
      // The read executors retry a 5xx on the strength of every statement
      // being a side-effect-free SELECT, so a write fails loudly instead of
      // running — the rejection must come before any round trip, not after
      // one whose side effects may have landed.
      let attempts = 0;
      setDb(
        clientWithBatch(() => {
          attempts++;
          return Promise.resolve([emptyResultSet()]);
        }),
      );
      await expect(
        batch([{ args: [], sql: "INSERT INTO t (x) VALUES (1)" }]),
      ).rejects.toThrow(
        "Read-only batch executors accept only SELECT statements",
      );
      expect(attempts).toBe(0);
    });
  }
});
