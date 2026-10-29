import { expect } from "@std/expect";
import { beforeEach, describe, it as test } from "@std/testing/bdd";
import { allTransfers } from "#accounting/queries.ts";
import {
  postTransferGroupBatches,
  postTransferGroups,
  postTransfers,
} from "#accounting/store.ts";
import { execute, queryAll } from "#db/client.ts";
import { tx, useTransactionalDb } from "#test-utils/ledger.ts";

const marker = (name: string) => ({
  args: [name],
  sql: "INSERT INTO posting_markers (name) VALUES (?)",
});
const markers = () =>
  queryAll<{ name: string }>("SELECT name FROM posting_markers ORDER BY name");

describe("db > accounting > atomic companion statements", () => {
  useTransactionalDb();
  beforeEach(async () => {
    await execute("CREATE TABLE posting_markers (name TEXT PRIMARY KEY)");
  });

  test("runs domain guards before transfer inserts in the same commit", async () => {
    await execute(
      "CREATE TRIGGER require_marker BEFORE INSERT ON transfers WHEN NOT EXISTS (SELECT 1 FROM posting_markers WHERE name = 'ready') BEGIN SELECT RAISE(ABORT, 'The domain marker is missing'); END",
    );
    await postTransferGroups([[tx()]], [marker("ready")]);
    expect(await markers()).toEqual([{ name: "ready" }]);
    expect(await allTransfers()).toHaveLength(1);
  });

  test("stores domain statements even when an exact reversal needs no new transfer", async () => {
    await postTransferGroups([], [marker("closed")]);
    expect(await markers()).toEqual([{ name: "closed" }]);
    expect(await allTransfers()).toEqual([]);
  });

  test("omits a conflicted plan's companion while another plan commits", async () => {
    const original = tx();
    await postTransfers([original]);
    const outcomes = await postTransferGroupBatches(
      [
        [[{ ...original, amount: original.amount + 1 }]],
        [[tx({ eventGroup: "other", reference: "other" })]],
      ],
      [[marker("conflicted")], [marker("safe")]],
    );
    expect(outcomes[0].kind).toBe("conflict");
    expect(outcomes[1].kind).toBe("posted");
    expect(await markers()).toEqual([{ name: "safe" }]);
    expect(await allTransfers()).toHaveLength(2);
  });
});
