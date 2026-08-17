/** The checks a post runs before writing are read in one go, not one by one. */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { transfersByEventGroup } from "#shared/accounting/queries.ts";
import { postTransferGroups, postTransfers } from "#shared/accounting/store.ts";
import { account } from "#shared/ledger/account.ts";
import type { TransferInput } from "#shared/ledger/types.ts";
import { saleAndPayment, tx, useTransactionalDb } from "#test-utils/ledger.ts";
import { recordQueries } from "#test-utils/record-queries.ts";

/** Every recorded statement that reads the ledger. `recordQueries` writes a
 *  whole batch as one entry, so this counts round trips, not statements. */
const ledgerReads = (seen: readonly string[]): string[] =>
  seen.filter((sql) => sql.includes("FROM transfers"));

/** The ledger round trips one piece of work takes. */
const readsDuring = async (work: () => Promise<unknown>): Promise<string[]> => {
  const seen: string[] = [];
  const restore = recordQueries(seen);
  try {
    await work();
  } finally {
    restore();
  }
  return ledgerReads(seen);
};

/** A leg voiding `originalId`, which makes the post check the original too. */
const reversalOf = (originalId: number): TransferInput[] => [
  tx({
    destination: account("attendee", 1),
    eventGroup: "evt-void",
    reference: "void",
    reversesId: originalId,
    source: account("revenue", 1),
  }),
];

/** Store one sale on its own and hand back the id a reversal can point at. */
const storedSaleId = async (): Promise<number> => {
  await postTransfers([tx({ eventGroup: "evt-1", reference: "sale" })]);
  const [sale] = await transfersByEventGroup("evt-1");
  if (sale === undefined) throw new Error("The stored sale was not read back");
  return sale.id;
};

describe("db > accounting > store > snapshot batching", () => {
  useTransactionalDb();

  test("checks a fresh event against the ledger in one round trip", async () => {
    const reads = await readsDuring(() =>
      postTransferGroups([saleAndPayment()]),
    );

    expect(reads).toHaveLength(1);
  });

  test("still takes one round trip when a reversal adds a third check", async () => {
    const originalId = await storedSaleId();

    const reads = await readsDuring(() =>
      postTransferGroups([reversalOf(originalId)]),
    );

    expect(reads).toHaveLength(1);
  });

  test("asks all three checks within the one round trip it takes", async () => {
    const originalId = await storedSaleId();

    const [snapshot] = await readsDuring(() =>
      postTransferGroups([reversalOf(originalId)]),
    );

    expect(snapshot).toContain("event_group IN");
    expect(snapshot).toContain("reference IN");
    expect(snapshot).toContain("id IN");
  });

  test("skips the round trip entirely when there is nothing to check", async () => {
    const reads = await readsDuring(() => postTransferGroups([[], []]));

    expect(reads).toEqual([]);
  });
});
