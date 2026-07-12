// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  recentTransfers,
  transfersByEventGroup,
} from "#shared/accounting/queries.ts";
import { postTransfers } from "#shared/accounting/store.ts";
import { account } from "#shared/ledger/account.ts";
import { tx, useTransactionalDb } from "#test-utils/ledger.ts";

// jscpd:ignore-end

const world = account("external", "world");

describe("db > accounting > transfer reads", () => {
  useTransactionalDb();

  test("recentTransfers returns newest first, capped at the limit", async () => {
    // Three distinct business times plus a same-time pair to exercise the id
    // tie-break. Insertion order is deliberately not time order.
    await postTransfers([
      tx({ occurredAt: "2026-06-21T00:00:00.000Z", reference: "mid" }),
      tx({ occurredAt: "2026-06-23T00:00:00.000Z", reference: "new" }),
      tx({ occurredAt: "2026-06-19T00:00:00.000Z", reference: "old" }),
      tx({ occurredAt: "2026-06-23T00:00:00.000Z", reference: "new2" }),
    ]);
    // Limit below the row count proves the cap is applied in SQL, and the
    // result is ordered by occurred_at DESC then id DESC.
    const top = await recentTransfers(3);
    expect(top.map((t) => t.reference)).toEqual(["new2", "new", "mid"]);
  });

  test("recentTransfers returns all rows when the limit exceeds the count", async () => {
    await postTransfers([
      tx({ occurredAt: "2026-06-21T00:00:00.000Z", reference: "a" }),
      tx({ occurredAt: "2026-06-22T00:00:00.000Z", reference: "b" }),
    ]);
    const all = await recentTransfers(100);
    expect(all.map((t) => t.reference)).toEqual(["b", "a"]);
  });

  test("transfersByEventGroup returns only that event's legs", async () => {
    await postTransfers([
      tx({ eventGroup: "evt-x", reference: "x-sale" }),
      tx({
        destination: account("attendee", 1),
        eventGroup: "evt-x",
        reference: "x-pay",
        source: world,
      }),
    ]);
    await postTransfers([tx({ eventGroup: "evt-y", reference: "y-sale" })]);
    const legs = await transfersByEventGroup("evt-x");
    expect(legs.map((t) => t.reference).toSorted()).toEqual([
      "x-pay",
      "x-sale",
    ]);
  });
});
