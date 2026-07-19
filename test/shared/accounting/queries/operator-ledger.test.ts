// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  MANUAL_LISTING_COST,
  MANUAL_LISTING_INCOME,
} from "#shared/accounting/manual-entries.ts";
import {
  ledgerTotals,
  transferActivityBounds,
  visibleTransfers,
} from "#shared/accounting/queries.ts";
import { emptyRange, type LedgerRange } from "#shared/accounting/range.ts";
import { postTransfers } from "#shared/accounting/store.ts";
import { account } from "#shared/ledger/account.ts";
import { tx, useTransactionalDb } from "#test-utils/ledger.ts";

// jscpd:ignore-end

const world = account("external", "world");
const feeIncome = account("fee_income", "booking");
const writeoff = account("writeoff", "default");
const epochMs = (iso: string): number => new Date(iso).getTime();

/** A representative booking spread of legs: a sale, the matching cash
 * payment (external), a booking fee, a write-up adjustment, and an unrelated
 * attendee's cash refund (external). */
const seedLedger = (): Promise<unknown> =>
  postTransfers([
    tx({
      amount: 5000,
      destination: account("revenue", 1),
      kind: "sale",
      reference: "sale-1",
      source: account("attendee", 1),
    }),
    tx({
      amount: 5000,
      destination: account("attendee", 1),
      kind: "payment",
      reference: "pay-1",
      source: world,
    }),
    tx({
      amount: 200,
      destination: feeIncome,
      kind: "fee",
      reference: "fee-1",
      source: account("attendee", 1),
    }),
    tx({
      amount: 300,
      destination: account("revenue", 1),
      kind: "adjustment",
      reference: "adj-1",
      source: writeoff,
    }),
    tx({
      amount: 1000,
      destination: world,
      kind: "refund_cash",
      reference: "refund-1",
      source: account("attendee", 2),
    }),
  ]);

describe("db > accounting > operator ledger stats and visible list", () => {
  useTransactionalDb();

  test("ledgerTotals derives the four headline figures over the whole ledger", async () => {
    await seedLedger();
    // income = sale 5000 + write-up 300; due = (sale 5000 + fee 200 +
    // refund_cash 1000) - payment 5000; refunded = 1000; fees = 200.
    expect(await ledgerTotals(emptyRange)).toEqual({
      due: 1200,
      fees: 200,
      income: 5300,
      refunded: 1000,
    });
  });

  test("ledgerTotals counts owner-entered outside listing income", async () => {
    await postTransfers([
      tx({
        amount: 700,
        destination: account("revenue", 1),
        kind: MANUAL_LISTING_INCOME,
        reference: "manual-income",
        source: world,
      }),
      tx({
        amount: 200,
        destination: world,
        kind: MANUAL_LISTING_COST,
        reference: "manual-cost",
        source: account("revenue", 1),
      }),
    ]);
    expect(await ledgerTotals(emptyRange)).toEqual({
      due: 0,
      fees: 0,
      income: 700,
      refunded: 0,
    });
  });

  test("ledgerTotals is empty (all zero) for a ledger with no rows", async () => {
    expect(await ledgerTotals(emptyRange)).toEqual({
      due: 0,
      fees: 0,
      income: 0,
      refunded: 0,
    });
  });

  test("visibleTransfers hides every external cash leg, newest first", async () => {
    await seedLedger();
    const rows = await visibleTransfers(emptyRange, null, 100);
    // The payment and refund_cash legs are gone. Only internal legs remain.
    expect(rows.map((row) => row.reference)).toEqual([
      "adj-1",
      "fee-1",
      "sale-1",
    ]);
    expect(rows.every((r) => r.source.type !== "external")).toBe(true);
    expect(rows.every((r) => r.destination.type !== "external")).toBe(true);
  });

  test("visibleTransfers keeps owner-entered manual rows with external accounts", async () => {
    await postTransfers([
      tx({
        destination: account("attendee", 1),
        kind: "payment",
        reference: "ordinary-payment",
        source: world,
      }),
      tx({
        destination: account("revenue", 1),
        kind: MANUAL_LISTING_INCOME,
        reference: "manual-income",
        source: world,
      }),
    ]);
    const rows = await visibleTransfers(emptyRange, null, 100);
    expect(rows.map((r) => r.reference)).toEqual(["manual-income"]);
    expect(rows[0]?.source).toEqual(world);
  });

  test("visibleTransfers does not treat manual wildcard prefixes as manual rows", async () => {
    await postTransfers([
      tx({
        destination: account("attendee", 1),
        kind: "manualXpayment",
        reference: "manual-wildcard",
        source: world,
      }),
    ]);
    expect(await visibleTransfers(emptyRange, null, 100)).toEqual([]);
  });

  test("visibleTransfers scoped to a listing keeps only that revenue account's legs", async () => {
    await seedLedger();
    const rows = await visibleTransfers(emptyRange, [1], 100);
    expect(rows.map((r) => r.kind).toSorted()).toEqual(["adjustment", "sale"]);
  });

  test("visibleTransfers uses one path for several listing accounts", async () => {
    await postTransfers([
      tx({
        destination: account("revenue", 1),
        reference: "listing-1",
        source: account("attendee", 1),
      }),
      tx({
        destination: account("revenue", 2),
        reference: "listing-2",
        source: account("attendee", 2),
      }),
      tx({
        destination: account("revenue", 3),
        reference: "listing-3",
        source: account("attendee", 3),
      }),
    ]);
    const rows = await visibleTransfers(emptyRange, [1, 2], 100);
    expect(rows.map((row) => row.reference).toSorted()).toEqual([
      "listing-1",
      "listing-2",
    ]);
    expect(await visibleTransfers(emptyRange, [], 100)).toEqual([]);
  });

  test("visibleTransfers caps to the limit", async () => {
    await seedLedger();
    expect(await visibleTransfers(emptyRange, null, 2)).toHaveLength(2);
  });

  test("a date range bounds the totals and the list to [start, end)", async () => {
    await postTransfers([
      tx({
        amount: 1000,
        destination: account("revenue", 1),
        kind: "sale",
        occurredAt: "2026-06-21T00:00:00.000Z",
        reference: "at-start",
        source: account("attendee", 1),
      }),
      tx({
        amount: 2000,
        destination: account("revenue", 1),
        kind: "sale",
        occurredAt: "2026-06-22T12:00:00.000Z",
        reference: "inside",
        source: account("attendee", 1),
      }),
      tx({
        amount: 4000,
        destination: account("revenue", 1),
        kind: "sale",
        occurredAt: "2026-06-23T00:00:00.000Z",
        reference: "at-end",
        source: account("attendee", 1),
      }),
    ]);
    const range: LedgerRange = {
      endMs: epochMs("2026-06-23T00:00:00.000Z"),
      startMs: epochMs("2026-06-21T00:00:00.000Z"),
    };
    expect(await ledgerTotals(range)).toEqual({
      due: 3000,
      fees: 0,
      income: 3000,
      refunded: 0,
    });
    const rows = await visibleTransfers(range, null, 100);
    expect(rows.map((r) => r.reference)).toEqual(["inside", "at-start"]);
  });

  test("transferActivityBounds spans the earliest and latest occurred_at", async () => {
    await postTransfers([
      tx({ occurredAt: "2026-06-20T12:00:00.000Z", reference: "a" }),
    ]);
    await postTransfers([
      tx({
        eventGroup: "evt-2",
        occurredAt: "2026-06-24T12:00:00.000Z",
        reference: "b",
      }),
    ]);
    expect(await transferActivityBounds()).toEqual({
      maxMs: epochMs("2026-06-24T12:00:00.000Z"),
      minMs: epochMs("2026-06-20T12:00:00.000Z"),
    });
  });

  test("transferActivityBounds is null for an empty ledger", async () => {
    expect(await transferActivityBounds()).toBeNull();
  });
});
