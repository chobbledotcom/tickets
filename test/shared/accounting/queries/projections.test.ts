// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { KIND } from "#accounting/kinds.ts";
import { listingMoneyTotals } from "#accounting/listing-money-totals.ts";
import { MANUAL_LISTING_INCOME } from "#accounting/manual-entries.ts";
import {
  allTransfers,
  ledgerTotals,
  transfersByAccount,
} from "#accounting/queries.ts";
import { emptyRange } from "#accounting/range.ts";
import { postTransfers } from "#accounting/store.ts";
import { account } from "#shared/ledger/account.ts";
import { balanceOf, sumOfKind } from "#shared/ledger/project.ts";
import { tx, useTransactionalDb } from "#test-utils/ledger.ts";

// jscpd:ignore-end

const world = account("external", "world");
const feeIncome = account("fee_income", "booking");
const writeoff = account("writeoff", "default");
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

describe("db > accounting > SQL figures agree with pure projections", () => {
  useTransactionalDb();

  // The money arithmetic in ledgerTotals / listingMoneyTotals lives in SQL
  // CASE arms, which mutation testing cannot reach (they are string literals).
  // These dual-read tests compare each figure with the same pure fold over the
  // identical slice, so an edited CASE arm cannot silently skew a report.
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

  test("listingMoneyTotals equals the pure folds over selected listing legs", async () => {
    await seedMixedLedger();
    const totals = await ledgerTotals(emptyRange);
    for (const [listingId, revenue] of [
      [1, revenue1],
      [2, revenue2],
    ] as const) {
      const breakdown = await listingMoneyTotals(emptyRange, [listingId]);
      const legs = await transfersByAccount(revenue);
      expect(breakdown.grossSales).toBe(sumOfKind(KIND.sale)(legs));
      expect(breakdown.refunds).toBe(sumOfKind(KIND.refundSale)(legs));
      expect(breakdown.externalIncome).toBe(
        sumOfKind(MANUAL_LISTING_INCOME)(legs),
      );
      // Recognised income - refunds - external costs must be exactly the
      // account's net ledger balance: the reconciliation the module promises.
      expect(breakdown.netBalance).toBe(balanceOf(revenue)(legs));
    }
    // The business-wide income figure is exactly the per-listing sum.
    const [one, two] = await Promise.all([
      listingMoneyTotals(emptyRange, [1]),
      listingMoneyTotals(emptyRange, [2]),
    ]);
    expect(one.recognisedIncome + two.recognisedIncome).toBe(totals.income);
  });
});
