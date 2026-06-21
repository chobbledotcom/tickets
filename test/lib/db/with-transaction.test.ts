import { createClient } from "@libsql/client";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { queryOne, setDb, withTransaction } from "#shared/db/client.ts";

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
