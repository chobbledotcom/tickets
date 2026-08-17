import type { Client, ResultSet } from "@libsql/client";
import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { FakeTime } from "@std/testing/time";
import { DatabaseBusyError, execute, setDb } from "#shared/db/client.ts";
import { emptyResultSet } from "#test-utils/db-helpers/result-set.ts";
import { withEnv } from "#test-utils/env.ts";

/**
 * The write-lock retry: a statement that loses SQLite's single write lock
 * (SQLITE_BUSY) is retried on a backoff ladder, and a lock that outlasts the
 * retries surfaces as DatabaseBusyError — the shape the request layer turns
 * into the friendly auto-reloading busy page. The ladder depends on where the
 * database lives: a remote server keeps the short 50/150/350ms ladder so an
 * edge request answers fast, while a file database (tests, local dev) keeps
 * yielding through three longer waits, because its lock is held by another
 * connection in this same process and one starved scheduler pass can keep an
 * ordinary transaction on the lock for around a second. A stubbed client
 * makes contention deterministic; FakeTime pins the backoff.
 */
describe("db > client write-lock retry", () => {
  const busyError = (): Error => new Error("SQLITE_BUSY: database is locked");
  const clientWith = (run: () => Promise<ResultSet>): Client =>
    ({ execute: run }) as unknown as Client;

  afterEach(() => setDb(null));

  test("DatabaseBusyError carries its name and friendly message", () => {
    const error = new DatabaseBusyError();
    expect(error.name).toBe("DatabaseBusyError");
    expect(error.message).toBe(
      "the database is too busy to complete this write",
    );
  });

  test("a briefly locked write retries and succeeds", async () => {
    using time = new FakeTime();
    let attempts = 0;
    setDb(
      clientWith(() => {
        attempts++;
        return attempts === 1
          ? Promise.reject(busyError())
          : Promise.resolve(emptyResultSet());
      }),
    );
    const promise = execute("INSERT INTO t (x) VALUES (1)");
    await time.tickAsync(50);
    const result = await promise;
    expect(result.rowsAffected).toBe(0);
    expect(attempts).toBe(2);
  });

  test("a remote database waits 50/150/350ms, then gives up as DatabaseBusyError", async () => {
    using env = withEnv({ DB_URL: "libsql://busy-ladder.example.turso.io" });
    using time = new FakeTime();
    let attempts = 0;
    setDb(
      clientWith(() => {
        attempts++;
        return Promise.reject(busyError());
      }),
    );
    // Attach the rejection expectation up front so the eventual failure is
    // handled while the fake clock ticks (an unhandled rejection would blow
    // up the test run before the final await).
    const outcome = expect(
      execute("INSERT INTO t (x) VALUES (1)"),
    ).rejects.toThrow(DatabaseBusyError);
    await time.tickAsync(0);
    expect(attempts).toBe(1);
    await time.tickAsync(49);
    expect(attempts).toBe(1); // first retry waits the full 50ms
    await time.tickAsync(1);
    expect(attempts).toBe(2);
    await time.tickAsync(149);
    expect(attempts).toBe(2); // second retry waits the full 150ms
    await time.tickAsync(1);
    expect(attempts).toBe(3);
    await time.tickAsync(349);
    expect(attempts).toBe(3); // third retry waits the full 350ms
    await time.tickAsync(1);
    expect(attempts).toBe(4); // one initial attempt + one per backoff entry
    await outcome;
    void env;
  });

  test("a file database outwaits a lock the remote ladder would give up on", async () => {
    using env = withEnv({ DB_URL: "file:/tmp/busy-ladder.db" });
    using time = new FakeTime();
    let attempts = 0;
    // The lock clears only on the fifth attempt — one past the remote
    // ladder's four. Before the file ladder existed this write died as
    // DatabaseBusyError, which is how a CPU-starved parallel test run turned
    // one slow transaction elsewhere in the process into a busy answer.
    setDb(
      clientWith(() => {
        attempts++;
        return attempts <= 4
          ? Promise.reject(busyError())
          : Promise.resolve(emptyResultSet());
      }),
    );
    const promise = execute("INSERT INTO t (x) VALUES (1)");
    await time.tickAsync(50);
    await time.tickAsync(150);
    await time.tickAsync(350);
    await time.tickAsync(700);
    const result = await promise;
    expect(result.rowsAffected).toBe(0);
    expect(attempts).toBe(5);
    void env;
  });

  test("a file database waits 700/1400/2800ms after the short ladder, then gives up", async () => {
    using env = withEnv({ DB_URL: "file:/tmp/busy-ladder.db" });
    using time = new FakeTime();
    let attempts = 0;
    setDb(
      clientWith(() => {
        attempts++;
        return Promise.reject(busyError());
      }),
    );
    const outcome = expect(
      execute("INSERT INTO t (x) VALUES (1)"),
    ).rejects.toThrow(DatabaseBusyError);
    await time.tickAsync(50);
    await time.tickAsync(150);
    await time.tickAsync(350);
    expect(attempts).toBe(4); // the whole remote ladder has run
    await time.tickAsync(699);
    expect(attempts).toBe(4); // fourth retry waits the full 700ms
    await time.tickAsync(1);
    expect(attempts).toBe(5);
    await time.tickAsync(1400);
    expect(attempts).toBe(6);
    await time.tickAsync(2800);
    expect(attempts).toBe(7); // one initial attempt + one per backoff entry
    await outcome;
    void env;
  });
});
