import { type Client, createClient, type Transaction } from "@libsql/client";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  registerTableInvalidation,
  resetCacheRegistry,
} from "#shared/cache-registry.ts";
import {
  DatabaseBusyError,
  queryOne,
  setDb,
  withTransaction,
  writeRowInTransaction,
} from "#shared/db/client.ts";
import {
  enableQueryLog,
  getQueryLog,
  runWithQueryLogContext,
  TRANSACTION_ROUNDTRIP_THRESHOLD,
} from "#shared/db/query-log.ts";
import {
  cleanupTestDbPath,
  createTrackedTestDbFile,
} from "#test-utils/temp-db-files.ts";
import { withVirtualBackoff } from "#test-utils/virtual-time.ts";

/**
 * withTransaction needs an interactive transaction that shares state with the
 * main connection, which a `:memory:` URL does not provide (each connection is a
 * separate DB). A temp file gives a real, isolated DB per test, so this sets one
 * up directly rather than using the shared in-memory harness.
 */
const withFileDb = async (run: () => Promise<void>): Promise<void> => {
  const path = await createTrackedTestDbFile(".db");
  const client = createClient({ url: `file:${path}` });
  setDb(client);
  try {
    await client.execute("CREATE TABLE t (x INTEGER)");
    await run();
  } finally {
    setDb(null);
    client.close();
    cleanupTestDbPath(path);
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

  test("allows a transaction holding exactly the threshold of statements", async () => {
    // Boundary of the round-trip guard: exactly THRESHOLD statements is fine —
    // the counter must start at zero, or the guard would trip one early.
    await withFileDb(async () => {
      await runWithQueryLogContext(async () => {
        await withTransaction(async (tx) => {
          for (let i = 0; i < TRANSACTION_ROUNDTRIP_THRESHOLD; i++) {
            await tx.execute("INSERT INTO t VALUES (1)");
          }
        });
      });
      expect(await count()).toBe(TRANSACTION_ROUNDTRIP_THRESHOLD);
    });
  });

  test("trips the round-trip guard when a transaction holds too many statements", async () => {
    // A chatty interactive transaction (many sequential round-trips holding the
    // write lock) is the "Transaction timed-out" shape; the guard fails it loudly
    // in dev/test so it gets restructured into a batch.
    await withFileDb(async () => {
      await expect(
        runWithQueryLogContext(async () => {
          await withTransaction(async (tx) => {
            for (let i = 0; i <= TRANSACTION_ROUNDTRIP_THRESHOLD; i++) {
              await tx.execute("INSERT INTO t VALUES (1)");
            }
          });
        }),
      ).rejects.toThrow(/Interactive transaction too chatty/);
    });
  });

  test("fires cache invalidation for each written statement after the commit", async () => {
    await withFileDb(async () => {
      resetCacheRegistry();
      try {
        let fired = 0;
        registerTableInvalidation(["t"], () => {
          fired++;
        });
        await withTransaction(async (tx) => {
          await tx.execute("INSERT INTO t VALUES (1)");
          await tx.execute("INSERT INTO t VALUES (2)");
          // Invalidation must wait for the commit — a write that has not
          // landed yet must not clear caches.
          expect(fired).toBe(0);
        });
        expect(fired).toBe(2);
      } finally {
        resetCacheRegistry();
      }
    });
  });

  test("a failed transaction does not poison the queue for the next one", async () => {
    // Each transaction waits for the previous one however it settled; the
    // predecessor's failure is its own caller's concern and must not reject
    // (or block) the transaction queued behind it.
    await withFileDb(async () => {
      await withTransaction(() => Promise.reject(new Error("boom"))).catch(
        () => undefined,
      );
      const result = await withTransaction(async (tx) => {
        await tx.execute("INSERT INTO t VALUES (1)");
        return "ok";
      });
      expect(result).toBe("ok");
      expect(await count()).toBe(1);
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
      expect(
        await withVirtualBackoff(() => withTransaction(async () => "ok")),
      ).toBe("ok");
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
        await withVirtualBackoff(() => withTransaction(async () => "x"));
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(DatabaseBusyError);
    } finally {
      setDb(null);
    }
  });

  test("writeRowInTransaction honours an explicit existing id verbatim, even 0", async () => {
    // `existingId ?? lastInsertRowid` must be nullish- (not falsy-) coalescing:
    // only a null existingId means "this was an INSERT, use its new rowid".
    const tx = {
      commit: () => Promise.resolve(),
      execute: () => Promise.resolve({ lastInsertRowid: 42n }),
      rollback: () => Promise.resolve(),
    } as unknown as Transaction;
    setDb(clientWith(() => Promise.resolve(tx)));
    try {
      const persistedIds: number[] = [];
      const id = await writeRowInTransaction(
        "UPDATE rows SET x = 1",
        0,
        (_tx, rowId) => {
          persistedIds.push(rowId);
          return Promise.resolve();
        },
      );
      expect(id).toBe(0);
      expect(persistedIds).toEqual([0]);
    } finally {
      setDb(null);
    }
  });

  test("surfaces the original error when the rollback also fails", async () => {
    // A failed commit leaves the transaction in a state where rollback can itself
    // throw; that failure is swallowed so the real cause (here the commit error)
    // is what propagates — and what the retry/give-up logic keys off.
    const tx = {
      commit: () => Promise.reject(new Error("commit boom")),
      rollback: () => Promise.reject(new Error("rollback boom")),
    } as unknown as Transaction;
    setDb(clientWith(() => Promise.resolve(tx)));
    try {
      let message = "";
      try {
        await withTransaction(async () => "x");
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toBe("commit boom");
    } finally {
      setDb(null);
    }
  });
});
