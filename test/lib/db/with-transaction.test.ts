import { type Client, createClient, type Transaction } from "@libsql/client";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  DatabaseBusyError,
  queryOne,
  setDb,
  withTransaction,
} from "#shared/db/client.ts";
import {
  enableQueryLog,
  getQueryLog,
  runWithQueryLogContext,
} from "#shared/db/query-log.ts";

/**
 * withTransaction needs an interactive transaction that shares state with the
 * main connection, which a `:memory:` URL does not provide (each connection is a
 * separate DB). A temp file gives a real, isolated DB per test, so this sets one
 * up directly rather than using the shared in-memory harness.
 */
const withFileDb = async (run: () => Promise<void>): Promise<void> => {
  const path = await Deno.makeTempFile({ suffix: ".db" });
  const client = createClient({ url: `file:${path}` });
  setDb(client);
  try {
    await client.execute("CREATE TABLE t (x INTEGER)");
    await run();
  } finally {
    setDb(null);
    client.close();
    await Deno.remove(path);
  }
};

const count = async (): Promise<number> => {
  const row = await queryOne<{ n: number }>("SELECT COUNT(*) AS n FROM t", []);
  return row!.n;
};

describe("withTransaction", () => {
  test("commits all writes on success", async () => {
    await withFileDb(async () => {
      await withTransaction(async (tx) => {
        await tx.execute("INSERT INTO t VALUES (1)");
        await tx.execute("INSERT INTO t VALUES (2)");
      });
      expect(await count()).toBe(2);
    });
  });

  test("tracks transactional statements for the query log / N+1 guard", async () => {
    await withFileDb(async () => {
      const log = await runWithQueryLogContext(async () => {
        enableQueryLog();
        await withTransaction(async (tx) => {
          await tx.execute("INSERT INTO t VALUES (1)");
          await tx.execute({ args: [], sql: "SELECT COUNT(*) AS n FROM t" });
        });
        return getQueryLog();
      });
      const sqls = log.map((entry) => entry.sql);
      expect(sqls).toContain("INSERT INTO t VALUES (1)");
      expect(sqls).toContain("SELECT COUNT(*) AS n FROM t");
    });
  });

  test("rolls back every write on error, then rethrows", async () => {
    await withFileDb(async () => {
      let message = "";
      try {
        await withTransaction(async (tx) => {
          await tx.execute("INSERT INTO t VALUES (1)");
          throw new Error("boom");
        });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toBe("boom");
      expect(await count()).toBe(0);
    });
  });
});

/**
 * The write lock is acquired with a bounded retry so concurrent writers
 * serialize rather than failing the loser; a database that stays locked surfaces
 * as DatabaseBusyError. These cases drive the contention paths with a stub client
 * (no real lock needed) so they're deterministic.
 */
describe("withTransaction lock contention", () => {
  const busy = (): Error => new Error("SQLITE_BUSY: database is locked");
  const fakeTx = (): Transaction =>
    ({
      commit: () => Promise.resolve(),
      rollback: () => Promise.resolve(),
    }) as unknown as Transaction;
  const clientWith = (transaction: () => Promise<Transaction>): Client =>
    ({ transaction }) as unknown as Client;

  test("retries a briefly-locked write lock, then succeeds", async () => {
    let calls = 0;
    setDb(
      clientWith(() => {
        calls++;
        return calls === 1 ? Promise.reject(busy()) : Promise.resolve(fakeTx());
      }),
    );
    try {
      expect(await withTransaction(async () => "ok")).toBe("ok");
      expect(calls).toBe(2);
    } finally {
      setDb(null);
    }
  });

  test("rethrows a non-lock error without retrying", async () => {
    let calls = 0;
    setDb(
      clientWith(() => {
        calls++;
        return Promise.reject(new Error("boom"));
      }),
    );
    try {
      let message = "";
      try {
        await withTransaction(async () => "x");
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toBe("boom");
      expect(calls).toBe(1);
    } finally {
      setDb(null);
    }
  });

  test("gives up as DatabaseBusyError when the lock never frees", async () => {
    setDb(clientWith(() => Promise.reject(busy())));
    try {
      let error: unknown;
      try {
        await withTransaction(async () => "x");
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(DatabaseBusyError);
    } finally {
      setDb(null);
    }
  });
});
