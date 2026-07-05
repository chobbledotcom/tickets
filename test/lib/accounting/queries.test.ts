import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { KIND } from "#shared/accounting/kinds.ts";
import {
  MANUAL_LISTING_COST,
  MANUAL_LISTING_INCOME,
} from "#shared/accounting/manual-entries.ts";
import {
  accountBalance,
  accountBalancesForIds,
  accountBalancesOfType,
  allTransfers,
  ledgerTotals,
  recentTransfers,
  transferActivityBounds,
  transfersByAccount,
  transfersByEventGroup,
  visibleTransfers,
} from "#shared/accounting/queries.ts";
import { emptyRange, type LedgerRange } from "#shared/accounting/range.ts";
import { postTransfers } from "#shared/accounting/store.ts";
import { listingRevenueBreakdown } from "#shared/db/listings.ts";
import { account } from "#shared/ledger/account.ts";
import { balanceOf, sumOfKind } from "#shared/ledger/project.ts";
import { tx, useTransactionalDb } from "#test-utils/ledger.ts";

const world = account("external", "world");
const feeIncome = account("fee_income", "booking");
const writeoff = account("writeoff", "default");
const epochMs = (iso: string): number => new Date(iso).getTime();

describe("db > accounting > queries", () => {
  useTransactionalDb();

  describe("balance queries", () => {
    test("accountBalance nets credits minus debits, zero when untouched", async () => {
      const attendee = account("attendee", 9);
      const revenue = account("revenue", 9);
      await postTransfers([
        tx({ destination: revenue, reference: "sale", source: attendee }),
        tx({
          amount: 2000,
          destination: attendee,
          reference: "pay",
          source: world,
        }),
      ]);
      expect(await accountBalance(revenue)).toBe(5000);
      expect(await accountBalance(attendee)).toBe(-3000); // still owes 3000
      expect(await accountBalance(account("revenue", 404))).toBe(0);
    });

    test("accountBalancesOfType returns every account of a type at once", async () => {
      await postTransfers([
        tx({
          amount: 1000,
          destination: account("revenue", 1),
          eventGroup: "e1",
          reference: "r1",
          source: account("attendee", 1),
        }),
      ]);
      await postTransfers([
        tx({
          amount: 3000,
          destination: account("revenue", 2),
          eventGroup: "e2",
          reference: "r2",
          source: account("attendee", 2),
        }),
      ]);
      const income = await accountBalancesOfType("revenue");
      expect(income.get("1")).toBe(1000);
      expect(income.get("2")).toBe(3000);
    });

    test("accountBalancesForIds scopes to given ids; empty is a no-op", async () => {
      await postTransfers([
        tx({
          amount: 1000,
          destination: account("revenue", 1),
          reference: "r1",
          source: account("attendee", 1),
        }),
        tx({
          amount: 3000,
          destination: account("revenue", 2),
          reference: "r2",
          source: account("attendee", 2),
        }),
      ]);
      const scoped = await accountBalancesForIds("revenue", ["1"]);
      expect(scoped.get("1")).toBe(1000);
      expect(scoped.has("2")).toBe(false);
      expect((await accountBalancesForIds("revenue", [])).size).toBe(0);
    });

    test("SQL balance agrees with the in-memory projection", async () => {
      const attendee = account("attendee", 5);
      const revenue = account("revenue", 5);
      await postTransfers([
        tx({ destination: revenue, reference: "s", source: attendee }),
        tx({
          amount: 2000,
          destination: attendee,
          reference: "p",
          source: world,
        }),
      ]);
      for (const acct of [attendee, revenue]) {
        const slice = await transfersByAccount(acct);
        expect(await accountBalance(acct)).toBe(balanceOf(acct)(slice));
      }
    });
  });

  describe("SQL figures agree with the pure projections", () => {
    // The money arithmetic in ledgerTotals / listingRevenueBreakdown lives in
    // SQL CASE arms, which mutation testing cannot reach (they are string
    // literals). These dual-read tests are their mutation resistance: every
    // figure must equal the same fold computed by the pure projections over
    // the identical slice, so an edited CASE arm fails here instead of
    // silently skewing a report.
    const attendee1 = account("attendee", 1);
    const attendee2 = account("attendee", 2);
    const revenue1 = account("revenue", 1);
    const revenue2 = account("revenue", 2);
    /** Seeded adjustment magnitudes (facts of the seed, asserted against). */
    const WRITE_UP = 400;
    const WRITE_DOWN = 150;

    /** A mixed ledger: a refunded fully-paid booking with a fee, an unpaid
     *  sale on a second listing, owner-entered income, and both directions of
     *  writeoff adjustment. */
    const seedMixedLedger = async (): Promise<void> => {
      await postTransfers([
        tx({ destination: revenue1, kind: KIND.sale, reference: "b-sale" }),
        tx({
          amount: 5000,
          destination: attendee1,
          kind: KIND.payment,
          reference: "b-pay",
          source: world,
        }),
        tx({
          amount: 300,
          destination: feeIncome,
          kind: KIND.fee,
          reference: "b-fee",
        }),
      ]);
      await postTransfers([
        tx({
          amount: 2000,
          destination: attendee1,
          eventGroup: "evt-refund",
          kind: KIND.refundSale,
          reference: "r-sale",
          source: revenue1,
        }),
        tx({
          amount: 2000,
          destination: world,
          eventGroup: "evt-refund",
          kind: KIND.refundCash,
          reference: "r-cash",
          source: attendee1,
        }),
        tx({
          amount: 100,
          destination: attendee1,
          eventGroup: "evt-refund",
          kind: KIND.refundFee,
          reference: "r-fee",
          source: feeIncome,
        }),
      ]);
      await postTransfers([
        tx({
          amount: 1000,
          destination: revenue2,
          eventGroup: "evt-owed",
          kind: KIND.sale,
          reference: "owed-sale",
          source: attendee2,
        }),
      ]);
      await postTransfers([
        tx({
          amount: 700,
          destination: revenue2,
          eventGroup: "evt-manual",
          kind: MANUAL_LISTING_INCOME,
          reference: "manual-income",
          source: world,
        }),
      ]);
      await postTransfers([
        tx({
          amount: WRITE_UP,
          destination: revenue1,
          eventGroup: "evt-up",
          kind: KIND.adjustment,
          reference: "adj-up",
          source: writeoff,
        }),
      ]);
      await postTransfers([
        tx({
          amount: WRITE_DOWN,
          destination: writeoff,
          eventGroup: "evt-down",
          kind: KIND.adjustment,
          reference: "adj-down",
          source: revenue2,
        }),
      ]);
    };

    test("ledgerTotals equals the pure folds over the whole ledger", async () => {
      await seedMixedLedger();
      const all = await allTransfers();
      const totals = await ledgerTotals(emptyRange);
      expect(totals.refunded).toBe(sumOfKind(KIND.refundCash)(all));
      expect(totals.fees).toBe(balanceOf(feeIncome)(all));
      expect(totals.due).toBe(
        -(balanceOf(attendee1)(all) + balanceOf(attendee2)(all)),
      );
      expect(totals.income).toBe(
        sumOfKind(KIND.sale)(all) +
          sumOfKind(MANUAL_LISTING_INCOME)(all) +
          WRITE_UP -
          WRITE_DOWN,
      );
      // And none of the figures are accidentally zero-on-zero matches.
      expect(totals.refunded).toBeGreaterThan(0);
      expect(totals.due).toBeGreaterThan(0);
    });

    test("listingRevenueBreakdown equals the pure folds over that listing's legs", async () => {
      await seedMixedLedger();
      const totals = await ledgerTotals(emptyRange);
      for (const [listingId, revenue] of [
        [1, revenue1],
        [2, revenue2],
      ] as const) {
        const breakdown = await listingRevenueBreakdown(listingId);
        const legs = await transfersByAccount(revenue);
        expect(breakdown.grossSales).toBe(sumOfKind(KIND.sale)(legs));
        expect(breakdown.refunds).toBe(sumOfKind(KIND.refundSale)(legs));
        expect(breakdown.externalIncome).toBe(
          sumOfKind(MANUAL_LISTING_INCOME)(legs),
        );
        // Recognised income − refunds − external costs must be exactly the
        // account's net ledger balance: the reconciliation the module header
        // promises.
        expect(breakdown.netBalance).toBe(balanceOf(revenue)(legs));
      }
      // The business-wide income figure is exactly the per-listing sum.
      const [one, two] = await Promise.all([
        listingRevenueBreakdown(1),
        listingRevenueBreakdown(2),
      ]);
      expect(one.recognisedIncome + two.recognisedIncome).toBe(totals.income);
    });
  });

  describe("reads", () => {
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
      // result is ordered by occurred_at DESC then id DESC (newest insert first
      // among the same-time pair).
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

  describe("operator ledger stats and visible list", () => {
    /** A representative booking spread of legs: a sale, the matching cash
     * payment (external), a booking fee, a write-up adjustment, and an
     * unrelated attendee's cash refund (external). */
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

    test("ledgerTotals derives the four headline figures over the whole ledger", async () => {
      await seedLedger();
      // income = sale 5000 + write-up 300; due = (sale 5000 + fee 200 +
      // refund_cash 1000) − payment 5000; refunded = 1000; fees = 200.
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
      // The payment (world→attendee) and refund_cash (attendee→world) are gone;
      // only the internal sale, fee, and adjustment legs remain.
      expect(rows.map((r) => r.kind).toSorted()).toEqual([
        "adjustment",
        "fee",
        "sale",
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
      const rows = await visibleTransfers(emptyRange, 1, 100);
      // revenue:1 is touched by the sale (credit) and the write-up (credit); the
      // fee leg (attendee→fee_income) is excluded.
      expect(rows.map((r) => r.kind).toSorted()).toEqual([
        "adjustment",
        "sale",
      ]);
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
          occurredAt: "2026-06-20T12:00:00.000Z",
          reference: "early",
          source: account("attendee", 1),
        }),
        tx({
          amount: 4000,
          destination: account("revenue", 1),
          kind: "sale",
          occurredAt: "2026-06-22T12:00:00.000Z",
          reference: "late",
          source: account("attendee", 1),
        }),
      ]);
      const range: LedgerRange = {
        endMs: epochMs("2026-06-23T00:00:00.000Z"),
        startMs: epochMs("2026-06-21T00:00:00.000Z"),
      };
      // Only the 06-22 sale falls inside the window.
      expect((await ledgerTotals(range)).income).toBe(4000);
      const rows = await visibleTransfers(range, null, 100);
      expect(rows.map((r) => r.reference)).toEqual(["late"]);
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
});
