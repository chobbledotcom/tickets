import type { Client, ResultSet } from "@libsql/client";
import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { FakeTime } from "@std/testing/time";
import { DatabaseBusyError, execute, setDb } from "#shared/db/client.ts";
import { expectFullBackoffWalk } from "#test-utils/backoff-walk.ts";
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

  test("a remote database waits 50/150/350ms, then gives up as DatabaseBusyError", () =>
    expectFullBackoffWalk({
      dbUrl: "libsql://busy-ladder.example.turso.io",
      failsWith: busyError,
      outcome: (operation) =>
        expect(operation).rejects.toThrow(DatabaseBusyError),
      sql: "INSERT INTO t (x) VALUES (1)",
      waits: [50, 150, 350],
    }));

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

  test("a file database waits 700/1400ms after the short ladder, then gives up", () =>
    expectFullBackoffWalk({
      dbUrl: "file:/tmp/busy-ladder.db",
      failsWith: busyError,
      outcome: (operation) =>
        expect(operation).rejects.toThrow(DatabaseBusyError),
      sql: "INSERT INTO t (x) VALUES (1)",
      waits: [50, 150, 350, 700, 1400],
    }));
});
