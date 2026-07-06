import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { withTransaction } from "#shared/db/client.ts";
import { linkTableSide } from "#shared/db/link-table.ts";
import { describeWithEnv } from "#test-utils/db.ts";

// Exercised through a real link table so the SQL runs against the schema's
// unique (key, value) index — the constraint the factory's dedupe protects.
const byUser = linkTableSide("user_logistics_agents", "user_id", "agent_id");
const byAgent = linkTableSide("user_logistics_agents", "agent_id", "user_id");

describeWithEnv("db link-table", { db: true }, () => {
  test("getIds returns [] when the key has no links", async () => {
    expect(await byUser.getIds(99)).toEqual([]);
  });

  test("setIds stores the set; getIds reads it back ascending", async () => {
    await byUser.setIds(1, [3, 1, 2]);
    expect(await byUser.getIds(1)).toEqual([1, 2, 3]);
  });

  test("setIds dedupes repeated ids", async () => {
    await byUser.setIds(1, [5, 5, 7]);
    expect(await byUser.getIds(1)).toEqual([5, 7]);
  });

  test("setIds replaces the previous set", async () => {
    await byUser.setIds(1, [1, 2, 3]);
    await byUser.setIds(1, [9]);
    expect(await byUser.getIds(1)).toEqual([9]);
  });

  test("setIds with [] clears every link for the key", async () => {
    await byUser.setIds(1, [1, 2]);
    await byUser.setIds(1, []);
    expect(await byUser.getIds(1)).toEqual([]);
  });

  test("the reverse side reads the same rows from the other column", async () => {
    await byUser.setIds(1, [4]);
    await byUser.setIds(2, [4]);
    expect(await byAgent.getIds(4)).toEqual([1, 2]);
  });

  test("setIdsTx replaces the set inside a caller's transaction", async () => {
    await byUser.setIds(1, [1, 2]);
    await withTransaction((tx) => byUser.setIdsTx(tx, 1, [8, 8, 6]));
    expect(await byUser.getIds(1)).toEqual([6, 8]);
  });

  test("setIdsTx with [] only deletes", async () => {
    await byUser.setIds(1, [1]);
    await withTransaction((tx) => byUser.setIdsTx(tx, 1, []));
    expect(await byUser.getIds(1)).toEqual([]);
  });

  test("setIdsTx rolls back with the surrounding transaction", async () => {
    await byUser.setIds(1, [1, 2]);
    await expect(
      withTransaction(async (tx) => {
        await byUser.setIdsTx(tx, 1, [9]);
        throw new Error("abort");
      }),
    ).rejects.toThrow("abort");
    expect(await byUser.getIds(1)).toEqual([1, 2]);
  });

  test("addIdsTx adds links without touching existing ones", async () => {
    await byUser.setIds(1, [1]);
    await withTransaction((tx) => byUser.addIdsTx(tx, 1, [3, 2, 3]));
    expect(await byUser.getIds(1)).toEqual([1, 2, 3]);
  });

  test("addIdsTx with [] runs no statement", async () => {
    let statements = 0;
    await withTransaction(async (tx) => {
      await byUser.addIdsTx(
        {
          execute: (stmt) => {
            statements += 1;
            return tx.execute(stmt);
          },
        },
        1,
        [],
      );
    });
    expect(statements).toBe(0);
  });

  test("clear removes every row for the key", async () => {
    await byUser.setIds(1, [4, 5]);
    await byUser.setIds(2, [4]);
    await byAgent.clear(4);
    expect(await byUser.getIds(1)).toEqual([5]);
    expect(await byUser.getIds(2)).toEqual([]);
  });
});
