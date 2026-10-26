import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { FakeTime } from "@std/testing/time";
import { execute, setDb } from "#db/client.ts";
import {
  emptyResultSet,
  stubClient,
  stubResultSet,
} from "#test-utils/db-helpers/result-set.ts";
import { withVirtualBackoff } from "#test-utils/virtual-time.ts";

/**
 * The transport retry: the connection between the edge and the database can
 * drop before the database ever answers, and Deno's fetch throws a raw
 * TypeError whose message names the phase the failure happened in. A read
 * replays either phase — it never changed anything. A write replays only a
 * Connect failure, a single time, because no request left the edge; a
 * SendRequest failure can arrive after the server ran the statement, so a
 * write never replays one. The messages below are the real ones from the
 * Bugsink events that motivated the rule (TICKETS-151, 141, 143, 121), with
 * the hosts replaced by examples.
 */
describe("db > client transport retry", () => {
  const connectDnsError = (): TypeError =>
    new TypeError(
      "error sending request from 85.208.99.12:41022 for https://mydb.aws-eu-west-1.turso.io/v2/pipeline (203.0.113.7:443): client error (Connect): dns error: failed to lookup address information",
    );

  const sendRequestClosedError = (): TypeError =>
    new TypeError(
      "error sending request from 85.208.99.12:41022 for https://mydb.aws-eu-west-1.turso.io/v2/pipeline (203.0.113.7:443): client error (SendRequest): connection closed before message completed",
    );

  const markerlessError = (): TypeError =>
    new TypeError("Cannot read properties of undefined (reading 'slug')");

  afterEach(() => setDb(null));

  test("a read whose connection closes before the answer retries and returns rows", async () => {
    let attempts = 0;
    setDb(
      stubClient({
        execute: () => {
          attempts++;
          return attempts === 1
            ? Promise.reject(sendRequestClosedError())
            : Promise.resolve(stubResultSet([{ ok: 1 }]));
        },
      }),
    );
    const result = await withVirtualBackoff(() => execute("SELECT 1 AS ok"));
    expect(attempts).toBe(2);
    expect(Array.from(result.rows)).toEqual([{ ok: 1 }]);
  });

  test("a write whose connection closes before the answer is never replayed", async () => {
    let attempts = 0;
    setDb(
      stubClient({
        execute: () => {
          attempts++;
          return Promise.reject(sendRequestClosedError());
        },
      }),
    );
    await expect(
      withVirtualBackoff(() => execute("INSERT INTO t (x) VALUES (1)")),
    ).rejects.toThrow(
      "client error (SendRequest): connection closed before message completed",
    );
    expect(attempts).toBe(1);
  });

  test("a write that cannot connect once retries a single time and completes", async () => {
    let attempts = 0;
    setDb(
      stubClient({
        execute: () => {
          attempts++;
          return attempts === 1
            ? Promise.reject(connectDnsError())
            : Promise.resolve(emptyResultSet());
        },
      }),
    );
    const result = await withVirtualBackoff(() =>
      execute("INSERT INTO t (x) VALUES (1)"),
    );
    // Two attempts: the first never left the edge, so the one successful run
    // is the write's only application.
    expect(attempts).toBe(2);
    expect(result.rowsAffected).toBe(0);
  });

  test("a Connect failure earns its single retry on a read and on a write, never the ladder", async () => {
    using time = new FakeTime();
    let attempts = 0;
    setDb(
      stubClient({
        execute: () => {
          attempts++;
          return Promise.reject(connectDnsError());
        },
      }),
    );
    const read = execute("SELECT 1 AS ok");
    const readOutcome = expect(read).rejects.toThrow(
      "client error (Connect): dns error",
    );
    const write = execute("INSERT INTO t (x) VALUES (1)");
    const writeOutcome = expect(write).rejects.toThrow(
      "client error (Connect): dns error",
    );
    // One wait of 50ms carries both retries: attempt 0 fails on each, the
    // single retry fails on each, and the failure propagates. A ladder kind
    // would still be walking its 150ms and 350ms waits here.
    await time.tickAsync(50);
    await readOutcome;
    await writeOutcome;
    expect(attempts).toBe(4);
  });

  for (const [label, sql] of [
    ["read", "SELECT 1 AS ok"],
    ["write", "INSERT INTO t (x) VALUES (1)"],
  ] as const) {
    test(`a TypeError without a transport marker fails at once on a ${label}`, async () => {
      let attempts = 0;
      setDb(
        stubClient({
          execute: () => {
            attempts++;
            return Promise.reject(markerlessError());
          },
        }),
      );
      await expect(withVirtualBackoff(() => execute(sql))).rejects.toThrow(
        "Cannot read properties of undefined",
      );
      expect(attempts).toBe(1);
    });
  }
});
