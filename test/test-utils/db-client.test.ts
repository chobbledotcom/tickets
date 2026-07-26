import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { createTestDbClient } from "#test-utils/db-client.ts";
import { tempDir } from "#test-utils/files.ts";

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
    const client = await createTestDbClient(`${dir.path}/test.db`);
    return {
      client,
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
});
