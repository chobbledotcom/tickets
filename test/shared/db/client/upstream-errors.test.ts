import { type Client, LibsqlError, type ResultSet } from "@libsql/client";
import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { FakeTime } from "@std/testing/time";
import {
  execute,
  executeBatch,
  queryBatch,
  type SqlStatement,
  setDb,
} from "#shared/db/client.ts";
import { emptyResultSet } from "#test-utils/db-helpers/result-set.ts";

/**
 * The transient upstream retry: the libsql server itself occasionally answers
 * a round trip with a fleeting gateway failure (a Turso 502/503/504, which the
 * client surfaces as a SERVER_ERROR LibsqlError naming the HTTP status). Those
 * retry on the shared 50/150/350ms backoff — but only on reads: a 5xx on a
 * write may have landed server-side before the gateway timed out, and replaying
 * it would double-apply, so writes (and the transactions that hold them) are not
 * retried for upstream errors. A hiccup that outlasts the retries rethrows the
 * original error (a sustained outage should still reach the error log), unlike
 * an exhausted write lock which becomes DatabaseBusyError. SQLITE_BUSY is always
 * safe to retry — the lock was never taken, so nothing ran. Any other failure
 * — a non-transient status, a non-SERVER_ERROR code, or a plain Error with a
 * lookalike message — fails immediately without a retry.
 */
describe("db > client transient upstream retry", () => {
  const upstreamError = (status: number): LibsqlError =>
    new LibsqlError(`Server returned HTTP status ${status}`, "SERVER_ERROR");
  const clientWith = (run: () => Promise<ResultSet>): Client =>
    ({ execute: run }) as unknown as Client;
  const clientWithBatch = (run: () => Promise<ResultSet[]>): Client =>
    ({ batch: run }) as unknown as Client;

  afterEach(() => setDb(null));

  for (const status of [502, 503, 504]) {
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

  test("an upstream hiccup that outlasts the retries rethrows the original error", async () => {
    using time = new FakeTime();
    let attempts = 0;
    const failure = upstreamError(504);
    setDb(
      clientWith(() => {
        attempts++;
        return Promise.reject(failure);
      }),
    );
    // Identity: the original error propagates unswapped — a sustained outage
    // is reported as itself, not disguised as write-lock contention.
    const outcome = expect(execute("SELECT 1")).rejects.toBe(failure);
    await time.tickAsync(50);
    expect(attempts).toBe(2);
    await time.tickAsync(150);
    expect(attempts).toBe(3);
    await time.tickAsync(350);
    expect(attempts).toBe(4);
    await outcome;
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
    ["a CTE-led UPDATE", "WITH x AS (SELECT 1) UPDATE t SET a = ?"],
  ] as const) {
    test(`a fleeting upstream 504 on ${label} is not retried`, async () => {
      // A 5xx on a write may have committed before the gateway timed out;
      // replaying it could double-apply, so writes never retry upstream errors
      // even when a read of the same shape would. A WITH-prefixed UPDATE is a
      // write too — the CTE prefix must not trip the read-only retry gate.
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

  test("a read batch retries on a 504 and succeeds", async () => {
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
    const promise = queryBatch([{ args: [], sql: "SELECT 1" }]);
    await time.tickAsync(50);
    const result = await promise;
    expect(result).toHaveLength(1);
    expect(attempts).toBe(2);
  });
});
