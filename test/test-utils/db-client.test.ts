import { createClient } from "@libsql/client";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { createTestDbClient } from "#test-utils/db-client.ts";
import { tempDir } from "#test-utils/files.ts";

/** Swap `globalThis.gc` for a counter, returning it with its restorer. The
 * collector is only exposed under `--expose-gc`, so the original may be
 * undefined; either way the swap is undone on dispose. */
const countGcCalls = (): Disposable & { calls: () => number } => {
  const globalWithGc = globalThis as { gc?: () => void };
  const original = globalWithGc.gc;
  const state = { count: 0 };
  globalWithGc.gc = () => {
    state.count += 1;
  };
  return {
    calls: () => state.count,
    [Symbol.dispose]: () => {
      if (original === undefined) delete globalWithGc.gc;
      else globalWithGc.gc = original;
    },
  };
};

/** Read back the two speed settings the connection serving `client` runs with. */
const speedSettings = async (
  client: Awaited<ReturnType<typeof createTestDbClient>>,
): Promise<{ journalMode: unknown; synchronous: unknown }> => ({
  journalMode: (await client.execute("PRAGMA journal_mode")).rows[0]
    ?.journal_mode,
  synchronous: (await client.execute("PRAGMA synchronous")).rows[0]
    ?.synchronous,
});

describe("test database client", () => {
  const openClient = async () => {
    const dir = tempDir({ prefix: "tickets-db-client-test-" });
    const path = `${dir.path}/test.db`;
    const client = await createTestDbClient(path);
    return {
      client,
      path,
      [Symbol.dispose]: () => {
        client.close();
        dir.dispose();
      },
    };
  };

  test("opens with journalling and disk flushing switched off", async () => {
    using opened = await openClient();
    expect(await speedSettings(opened.client)).toEqual({
      journalMode: "memory",
      synchronous: 0,
    });
  });

  test("keeps those settings after an interactive transaction", async () => {
    using opened = await openClient();
    const { client } = opened;
    await client.execute("CREATE TABLE counters (value INTEGER)");

    const transaction = await client.transaction("write");
    await transaction.execute("INSERT INTO counters (value) VALUES (1)");
    await transaction.commit();

    // libsql hands its connection to the transaction and opens a fresh one for
    // everything after it; a fresh plain connection would report "delete" / 2.
    expect(await speedSettings(client)).toEqual({
      journalMode: "memory",
      synchronous: 0,
    });
  });

  test("still reads and writes normally after a transaction", async () => {
    using opened = await openClient();
    const { client } = opened;
    await client.execute("CREATE TABLE counters (value INTEGER)");

    const transaction = await client.transaction("write");
    await transaction.execute("INSERT INTO counters (value) VALUES (7)");
    await transaction.commit();
    await client.execute("INSERT INTO counters (value) VALUES (11)");

    const result = await client.execute(
      "SELECT value FROM counters ORDER BY value ASC",
    );
    expect(result.rows.map((row) => row.value)).toEqual([7, 11]);
  });

  test("frees abandoned connections when a write loses the lock", async () => {
    using opened = await openClient();
    const { client } = opened;
    await client.execute("CREATE TABLE counters (value INTEGER)");
    // A second raw connection holding the write lock, the way an abandoned
    // transaction connection does until garbage collection finalises it.
    const competitor = createClient({ url: `file:${opened.path}` });
    const held = await competitor.transaction("write");
    try {
      using gc = countGcCalls();
      await expect(
        client.execute("INSERT INTO counters (value) VALUES (1)"),
      ).rejects.toThrow(/locked|BUSY/i);
      // The collector ran before the failure reached the caller, so the
      // production ladder's next attempt finds the phantom holder gone.
      expect(gc.calls()).toBe(1);
    } finally {
      await held.rollback();
      competitor.close();
    }
  });

  test("leaves failures that are not lock contention alone", async () => {
    using opened = await openClient();
    using gc = countGcCalls();
    await expect(
      opened.client.execute("SELECT * FROM no_such_table"),
    ).rejects.toThrow(/no such table/i);
    expect(gc.calls()).toBe(0);
  });
});
