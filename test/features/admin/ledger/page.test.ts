/** The ledger page module: the scope options its loaders bring in, and the
 * top stats table's figures. The full list views have their own suite; the
 * scope tests pin the group-name and group-linked-listing options the page
 * module assembles itself, and the stats tests pin the figures the all-scope
 * table reports. */

import { assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { KIND } from "#accounting/kinds.ts";
import { postTransfers } from "#accounting/store.ts";
import { assignListingsToGroup } from "#db/groups/membership/package-writes.ts";
import { formatSignedCurrency } from "#shared/currency.ts";
import { account } from "#shared/ledger/account.ts";
import { ledgerPageHtml } from "#test/integration/server/ledger/helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { tx } from "#test-utils/ledger.ts";
import { renderAdminPage } from "#test-utils/servicing.ts";

describeWithEnv("the admin ledger page", { db: true }, () => {
  test("offers every group's name as a scope option", async () => {
    await createTestGroup({ name: "Weekend runs" });

    const html = await ledgerPageHtml("/admin/ledger");

    assertStringIncludes(html, "Weekend runs");
  });

  test("offers a group-linked listing by name in the listing scope", async () => {
    const group = await createTestGroup({ name: "Sprint week" });
    const listing = await createTestListing({ name: "Sprint night" });
    await assignListingsToGroup([listing.id], group.id);

    const html = await ledgerPageHtml("/admin/ledger?scope=listing");

    assertStringIncludes(html, "Sprint night");
  });

  /** The scoped stats: a second seed date keeps these legs out of the
   *  all-scope table's range above. */
  const SCOPED_SEED_DATE = "2030-07-08T00:00:00.000Z";
  const SCOPED_SEED_RANGE = "from=2030-07-08&to=2030-07-09";

  test("the listing scope stats head with the listing's name and total its own figures", async () => {
    const listing = await createTestListing({ name: "Scoped solo" });
    const other = await createTestListing({ name: "Scoped aside" });
    await postTransfers([
      tx({
        amount: 25000,
        destination: account("revenue", listing.id),
        kind: KIND.sale,
        occurredAt: SCOPED_SEED_DATE,
        reference: "scoped-solo",
      }),
      tx({
        amount: 30000,
        destination: account("revenue", other.id),
        kind: KIND.sale,
        occurredAt: SCOPED_SEED_DATE,
        reference: "scoped-aside",
      }),
    ]);

    const body = await renderAdminPage(
      `/admin/ledger?${SCOPED_SEED_RANGE}&listing=${listing.id}`,
    );

    assertStringIncludes(body, "<h2>Scoped solo</h2>");
    assertStringIncludes(body, formatSignedCurrency(25000, true));
    // The other listing's sale stays out of the stats and the rows.
    expect(body.includes(formatSignedCurrency(30000, true))).toBe(false);
  });

  test("the group scope stats total the group's listings, not the group's id", async () => {
    const group = await createTestGroup({ name: "Scoped pair" });
    const left = await createTestListing({ name: "Scoped left" });
    const right = await createTestListing({ name: "Scoped right" });
    const stray = await createTestListing({ name: "Scoped stray" });
    await assignListingsToGroup([left.id, right.id], group.id);
    await postTransfers([
      tx({
        amount: 25000,
        destination: account("revenue", left.id),
        kind: KIND.sale,
        occurredAt: SCOPED_SEED_DATE,
        reference: "scoped-left",
      }),
      tx({
        amount: 30000,
        destination: account("revenue", right.id),
        kind: KIND.sale,
        occurredAt: SCOPED_SEED_DATE,
        reference: "scoped-right",
      }),
      tx({
        amount: 40000,
        destination: account("revenue", stray.id),
        kind: KIND.sale,
        occurredAt: SCOPED_SEED_DATE,
        reference: "scoped-stray",
      }),
    ]);

    const body = await renderAdminPage(
      `/admin/ledger?${SCOPED_SEED_RANGE}&group=${group.id}`,
    );

    assertStringIncludes(body, "<h2>Scoped pair</h2>");
    assertStringIncludes(body, formatSignedCurrency(55000, true));
    // The listing outside the group stays out of the stats and the rows.
    expect(body.includes(formatSignedCurrency(40000, true))).toBe(false);
  });

  /** The ledger rows this suite seeds sit on their own day, and the render
   *  filters to it: the top table's totals are global, so the assertions must
   *  not read whatever legs another test file left in the shared isolate. */
  const SEED_DATE = "2030-04-05T00:00:00.000Z";
  const SEED_RANGE = "/admin/ledger?from=2030-04-05&to=2030-04-06";

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

  /** The exact text of the top table's net cell: the labelled row is
   * isolated first, and the value cell must lie inside that row, so another
   * row's amount cannot pass and a cell-less labelled row cannot borrow
   * one. */
  const netCellValue = (body: string): string => {
    const labelAt = body.indexOf("Net after service costs");
    expect(labelAt).toBeGreaterThan(-1);
    const rowStart = body.lastIndexOf("<tr>", labelAt);
    expect(rowStart).toBeGreaterThan(-1);
    const rowEnd = body.indexOf("</tr>", labelAt);
    expect(rowEnd).toBeGreaterThan(-1);
    const row = body.slice(rowStart, rowEnd);
    const cellStart = row.indexOf("<td>");
    expect(cellStart).toBeGreaterThan(-1);
    const cellEnd = row.indexOf("</td>", cellStart);
    expect(cellEnd).toBeGreaterThan(-1);
    return row.slice(cellStart + 4, cellEnd);
  };

  test("shows servicing costs and the net beside the total income", async () => {
    await seedLedger(true);
    const body = await renderAdminPage(SEED_RANGE);

    // The three figures the page owes the operator: the total income, the
    // service costs taken away, and the total income minus those costs. The
    // expected strings come from the same formatter the page renders with.
    assertStringIncludes(body, "Total income earned");
    assertStringIncludes(body, formatSignedCurrency(25000, true));
    assertStringIncludes(body, "Service event costs");
    assertStringIncludes(body, formatSignedCurrency(-9000, true));
    expect(netCellValue(body)).toBe(formatSignedCurrency(16000, false));
    // The costs and the net sit between the income and the rows that were
    // already there.
    const incomeAt = body.indexOf("Total income earned");
    const costsAt = body.indexOf("Service event costs");
    const netAt = body.indexOf("Net after service costs");
    const dueAt = body.indexOf("Customer balances due");
    expect(incomeAt).toBeLessThan(costsAt);
    expect(costsAt).toBeLessThan(netAt);
    expect(netAt).toBeLessThan(dueAt);
  });

  test("the net cell helper rejects a labelled row whose cell sits in a later row", () => {
    // Bong's trace: a labelled row with no value cell, followed by a row
    // that carries the amount. The helper must not read past the labelled
    // row for its value.
    const malformed =
      "<tr><th>Net after service costs</th></tr><tr><td>£250</td></tr>";
    expect(() => netCellValue(malformed)).toThrow();
  });

  test("a ledger with no service costs shows the net equal to the income", async () => {
    await seedLedger(false);
    const body = await renderAdminPage(SEED_RANGE);

    assertStringIncludes(body, formatSignedCurrency(25000, true));
    assertStringIncludes(body, formatSignedCurrency(0, true));
    // The income row already contains the net's unsigned string, so the net
    // assertion compares the net row's own cell exactly, sign included.
    expect(netCellValue(body)).toBe(formatSignedCurrency(25000, false));
  });
});
