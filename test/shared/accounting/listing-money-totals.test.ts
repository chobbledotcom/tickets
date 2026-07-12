import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { KIND } from "#shared/accounting/kinds.ts";
import { MANUAL_LISTING_INCOME } from "#shared/accounting/manual-entries.ts";
import { listingMoneyTotals } from "#shared/accounting/queries.ts";
import type { LedgerRange } from "#shared/accounting/range.ts";
import { postTransfers } from "#shared/accounting/store.ts";
import { account } from "#shared/ledger/account.ts";
import { tx, useTransactionalDb } from "#test-utils/ledger.ts";

const world = account("external", "world");
const writeoff = account("writeoff", "default");
const june: LedgerRange = {
  endMs: new Date("2026-07-01T00:00:00.000Z").getTime(),
  startMs: new Date("2026-06-01T00:00:00.000Z").getTime(),
};

describe("listingMoneyTotals", () => {
  useTransactionalDb();

  test("returns zero totals for no listing ids", async () => {
    expect(await listingMoneyTotals(june, [])).toEqual({ costs: 0, income: 0 });
  });

  test("combines only the selected listings and date range", async () => {
    await postTransfers([
      tx({
        amount: 1000,
        destination: account("revenue", 1),
        kind: KIND.sale,
        occurredAt: "2026-06-05T00:00:00.000Z",
        reference: "one-sale",
      }),
      tx({
        amount: 300,
        destination: account("revenue", 2),
        kind: MANUAL_LISTING_INCOME,
        occurredAt: "2026-06-06T00:00:00.000Z",
        reference: "two-income",
        source: world,
      }),
      tx({
        amount: 200,
        destination: account("revenue", 1),
        kind: KIND.adjustment,
        occurredAt: "2026-06-07T00:00:00.000Z",
        reference: "one-write-up",
        source: writeoff,
      }),
      tx({
        amount: 100,
        destination: writeoff,
        kind: KIND.adjustment,
        occurredAt: "2026-06-08T00:00:00.000Z",
        reference: "two-write-down",
        source: account("revenue", 2),
      }),
      tx({
        amount: 400,
        destination: world,
        kind: KIND.serviceCost,
        occurredAt: "2026-06-09T00:00:00.000Z",
        reference: "one-cost",
        source: account("cost", 1),
      }),
      tx({
        amount: 50,
        destination: account("cost", 2),
        kind: KIND.serviceCost,
        occurredAt: "2026-06-10T00:00:00.000Z",
        reference: "two-cost-reduction",
        source: world,
      }),
      tx({
        amount: 5000,
        destination: account("revenue", 1),
        kind: KIND.sale,
        occurredAt: "2026-07-05T00:00:00.000Z",
        reference: "later-sale",
      }),
      tx({
        amount: 700,
        destination: world,
        kind: KIND.serviceCost,
        occurredAt: "2026-06-11T00:00:00.000Z",
        reference: "other-cost",
        source: account("cost", 3),
      }),
    ]);

    expect(await listingMoneyTotals(june, [1, 2])).toEqual({
      costs: 350,
      income: 1400,
    });
  });
});
