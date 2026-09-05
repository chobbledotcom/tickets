import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { withTransaction } from "#db/client.ts";
import { linkTableSide, selfLinkTableSides } from "#db/link-table.ts";
import { runWithRequestCache } from "#shared/request-cache.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { countDatabaseCalls } from "#test-utils/subrequest-budget.ts";

// Exercised through a real link table so the SQL runs against the schema's
// unique (key, value) index — the constraint the factory's dedupe protects.
const byUser = linkTableSide("user_logistics_agents", "user_id", "agent_id");
const byAgent = linkTableSide("user_logistics_agents", "agent_id", "user_id");

// A listing's children and its parents are both listings, so this table is
// read from both ends of the same id.
const edges = selfLinkTableSides(
  "listing_parents",
  "parent_listing_id",
  "child_listing_id",
);

/** Count the database calls `work` makes with a request's memory switched on,
 * the way a real request runs. */
const callsInOneRequest = (
  limit: number,
  work: () => Promise<unknown>,
): Promise<number> =>
  runWithRequestCache(() => countDatabaseCalls(limit, work));

describeWithEnv("db link-table", { db: true }, () => {
  test("getIds returns [] when the key has no links", async () => {
    expect(await byUser.getIds(99)).toEqual([]);
  });

  test("getIdsByKeys buckets links and seeds unlinked keys", async () => {
    await byUser.setIds(1, [5, 3]);
    await byUser.setIds(2, [4]);
    expect(await byUser.getIdsByKeys([2, 3, 1])).toEqual(
      new Map([
        [2, [4]],
        [3, []],
        [1, [3, 5]],
      ]),
    );
  });

  test("getIdsByKeys dedupes keys and short-circuits an empty list", async () => {
    await byUser.setIds(1, [2]);
    expect(await byUser.getIdsByKeys([1, 1])).toEqual(new Map([[1, [2]]]));
    expect(await byUser.getIdsByKeys([])).toEqual(new Map());
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

  test("getIdsTx sees earlier transaction writes and returns ids ascending", async () => {
    await withTransaction(async (tx) => {
      await byUser.setIdsTx(tx, 1, [9, 3, 7]);
      expect(await byUser.getIdsTx(tx, 1)).toEqual([3, 7, 9]);
    });
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
          ...tx,
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

  describe("both directions of a self-linking table", () => {
    test("each side reads its own direction, ascending", async () => {
      await edges.pointsAt.setIds(1, [7, 3]);
      await edges.pointsAt.setIds(2, [3]);

      expect(await edges.pointsAt.getIds(1)).toEqual([3, 7]);
      expect(await edges.pointedAtBy.getIds(3)).toEqual([1, 2]);
    });

    test("asking both ways round about one record costs a single read", async () => {
      await edges.pointsAt.setIds(1, [3]);
      await edges.pointedAtBy.setIds(1, [4]);

      const both = await callsInOneRequest(1, async () => {
        expect(await edges.pointsAt.getIds(1)).toEqual([3]);
        expect(await edges.pointedAtBy.getIds(1)).toEqual([4]);
      });

      expect(both).toBe(1);
    });

    test("asking both ways round at once costs a single read", async () => {
      await edges.pointsAt.setIds(1, [3]);
      await edges.pointsAt.setIds(2, [3]);

      const both = await callsInOneRequest(1, async () => {
        const [children, parents] = await Promise.all([
          edges.pointsAt.getIdsByKeys([1, 2, 3]),
          edges.pointedAtBy.getIdsByKeys([1, 2, 3]),
        ]);
        expect(children).toEqual(
          new Map([
            [1, [3]],
            [2, [3]],
            [3, []],
          ]),
        );
        expect(parents).toEqual(
          new Map([
            [1, []],
            [2, []],
            [3, [1, 2]],
          ]),
        );
      });

      expect(both).toBe(1);
    });

    test("a record nobody links to comes back empty both ways", async () => {
      await edges.pointsAt.setIds(1, [3]);

      expect(await edges.pointsAt.getIdsByKeys([9])).toEqual(
        new Map([[9, []]]),
      );
      expect(await edges.pointedAtBy.getIdsByKeys([9])).toEqual(
        new Map([[9, []]]),
      );
    });

    test("an empty list of records reads nothing at all", async () => {
      const calls = await callsInOneRequest(0, async () => {
        expect(await edges.pointsAt.getIdsByKeys([])).toEqual(new Map());
        expect(await edges.pointedAtBy.getIdsByKeys([])).toEqual(new Map());
      });

      expect(calls).toBe(0);
    });

    test("a write makes the next read fetch again", async () => {
      await edges.pointsAt.setIds(1, [3]);
      await runWithRequestCache(async () => {
        expect(await edges.pointedAtBy.getIds(3)).toEqual([1]);
        await edges.pointsAt.setIds(2, [3]);
        expect(await edges.pointedAtBy.getIds(3)).toEqual([1, 2]);
      });
    });
  });

  test("a write makes a plain side's next read fetch again", async () => {
    await byUser.setIds(1, [3]);
    await runWithRequestCache(async () => {
      expect(await byAgent.getIds(3)).toEqual([1]);
      await byUser.setIds(2, [3]);
      expect(await byAgent.getIds(3)).toEqual([1, 2]);
    });
  });
});
