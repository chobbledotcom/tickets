// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  eventGroupHasLegs,
  orderModifierLines,
  recentTransfers,
  transfersByEventGroup,
} from "#accounting/queries.ts";
import { postTransfers } from "#accounting/store.ts";
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

  test("eventGroupHasLegs distinguishes stored and missing events", async () => {
    await postTransfers([
      tx({ eventGroup: "evt-stored", reference: "stored" }),
    ]);

    expect(await eventGroupHasLegs("evt-stored")).toBe(true);
    expect(await eventGroupHasLegs("evt-missing")).toBe(false);
  });

  test("orderModifierLines returns nothing for no event groups", async () => {
    expect(await orderModifierLines([])).toEqual(new Map());
  });

  test("orderModifierLines signs each order's modifier legs", async () => {
    await postTransfers([
      tx({
        amount: 100,
        destination: account("modifier", 7),
        eventGroup: "evt-mod",
        kind: "modifier",
        reference: "mod-charge",
      }),
      tx({
        amount: 40,
        destination: account("attendee", 1),
        eventGroup: "evt-mod",
        kind: "modifier",
        reference: "mod-discount",
        source: account("modifier", 8),
      }),
      // A sale leg must not join this order's modifier lines.
      tx({
        amount: 900,
        eventGroup: "evt-mod",
        kind: "sale",
        reference: "mod-sale",
      }),
    ]);
    await postTransfers([
      tx({
        amount: 55,
        destination: account("modifier", 9),
        eventGroup: "evt-other",
        kind: "modifier",
        reference: "other-charge",
      }),
    ]);
    expect(await orderModifierLines(["evt-mod", "evt-mod"])).toEqual(
      new Map([
        [
          "evt-mod",
          [
            { amount: 100, modifierId: 7 },
            { amount: -40, modifierId: 8 },
          ],
        ],
      ]),
    );
  });

  test("orderModifierLines adds up several legs of one modifier", async () => {
    await postTransfers([
      tx({
        amount: 100,
        destination: account("modifier", 7),
        eventGroup: "evt-sum",
        kind: "modifier",
        reference: "sum-one",
      }),
      tx({
        amount: 50,
        destination: account("modifier", 7),
        eventGroup: "evt-sum",
        kind: "modifier",
        reference: "sum-two",
      }),
    ]);
    expect(await orderModifierLines(["evt-sum"])).toEqual(
      new Map([["evt-sum", [{ amount: 150, modifierId: 7 }]]]),
    );
  });
});
