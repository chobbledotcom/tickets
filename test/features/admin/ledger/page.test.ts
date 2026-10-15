import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { KIND } from "#accounting/kinds.ts";
import { postTransfers } from "#accounting/store.ts";
import { formatSignedCurrency } from "#shared/currency.ts";
import { account } from "#shared/ledger/account.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { tx } from "#test-utils/ledger.ts";
import { renderAdminPage } from "#test-utils/servicing.ts";

/** The ledger rows this suite seeds sit on their own day, and the render
 *  filters to it: the top table's totals are global, so the assertions must
 *  not read whatever legs another test file left in the shared isolate. */
const SEED_DATE = "2030-04-05T00:00:00.000Z";
const SEED_RANGE = "/admin/ledger?from=2030-04-05&to=2030-04-06";

describeWithEnv("the ledger's top stats table", { db: true }, () => {
  /** Seeds a £250 sale on listing 1 with a £30 refund, plus a £90 service
   * cost unless the ledger is meant to hold none. */
  const seedLedger = async (withCosts: boolean): Promise<void> => {
    await postTransfers([
      tx({
        amount: 25000,
        destination: account("revenue", 1),
        kind: KIND.sale,
        occurredAt: SEED_DATE,
        reference: "b-sale",
      }),
      tx({
        amount: 3000,
        destination: account("attendee", 1),
        kind: KIND.refundSale,
        occurredAt: SEED_DATE,
        reference: "b-refund",
        source: account("revenue", 1),
      }),
      ...(withCosts
        ? [
            tx({
              amount: 9000,
              destination: account("external", "world"),
              kind: KIND.serviceCost,
              occurredAt: SEED_DATE,
              reference: "b-cost",
              source: account("cost", 1),
            }),
          ]
        : []),
    ]);
  };

  test("shows servicing costs and the net beside the total income", async () => {
    await seedLedger(true);
    const body = await renderAdminPage(SEED_RANGE);

    // The three figures the page owes the operator: the income, the costs
    // taken away, and the net after refunds and costs. The expected strings
    // come from the same formatter the page renders with.
    expect(body).toContain("Total income earned");
    expect(body).toContain(formatSignedCurrency(25000, true));
    expect(body).toContain("Service event costs");
    expect(body).toContain(formatSignedCurrency(-9000, true));
    expect(body).toContain("Net after refunds and costs");
    expect(body).toContain(formatSignedCurrency(13000, false));
    // The costs and the net sit between the income and the rows that were
    // already there.
    const incomeAt = body.indexOf("Total income earned");
    const costsAt = body.indexOf("Service event costs");
    const netAt = body.indexOf("Net after refunds and costs");
    const dueAt = body.indexOf("Customer balances due");
    expect(incomeAt).toBeLessThan(costsAt);
    expect(costsAt).toBeLessThan(netAt);
    expect(netAt).toBeLessThan(dueAt);
  });

  test("a ledger with no service costs shows the net at the income balance", async () => {
    await seedLedger(false);
    const body = await renderAdminPage(SEED_RANGE);

    expect(body).toContain(formatSignedCurrency(25000, true));
    expect(body).toContain(formatSignedCurrency(0, true));
    // The net carries the refund: the income balance minus nothing.
    expect(body).toContain(formatSignedCurrency(22000, false));
  });
});
