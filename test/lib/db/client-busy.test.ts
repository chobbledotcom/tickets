import type { Client, ResultSet } from "@libsql/client";
import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { FakeTime } from "@std/testing/time";
import { DatabaseBusyError, execute, setDb } from "#shared/db/client.ts";

/**
 * The write-lock retry: a statement that loses SQLite's single write lock
 * (SQLITE_BUSY) is retried on the documented 50/150/350ms backoff schedule,
 * and a lock that outlasts the retries surfaces as DatabaseBusyError — the
 * shape the request layer turns into the friendly auto-reloading busy page.
 * A stubbed client makes contention deterministic; FakeTime pins the backoff.
 */
describe("db > client write-lock retry", () => {
  const busyError = (): Error => new Error("SQLITE_BUSY: database is locked");
  const emptyResultSet = (): ResultSet => ({
    columns: [],
    columnTypes: [],
    lastInsertRowid: undefined,
    rows: [],
    rowsAffected: 0,
    toJSON: () => ({}),
  });
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

  test("waits 50/150/350ms between attempts, then gives up as DatabaseBusyError", async () => {
    using time = new FakeTime();
    let attempts = 0;
    setDb(
      clientWith(() => {
        attempts++;
        return Promise.reject(busyError());
      }),
    );
    const outcome = execute("INSERT INTO t (x) VALUES (1)").then(
      () => "resolved",
      (error: unknown) => error,
    );
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
    expect(await outcome).toBeInstanceOf(DatabaseBusyError);
  });
});
