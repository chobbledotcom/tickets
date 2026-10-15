import { assert } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { overviewStatsFromDbStats } from "#templates/admin/listings/overview.tsx";
import {
  registerListingTemplateHooks,
  renderListingDetail,
} from "#test/ui/templates/admin/listings/helpers.ts";
import { testListingWithCount } from "#test-utils/factories.ts";
import { says } from "#test-utils/says.ts";

describe("adminListingPage money breakdown", () => {
  registerListingTemplateHooks();

  const listing = testListingWithCount({ id: 7 });

  test("omits the section entirely when no breakdown is supplied", () => {
    const html = renderListingDetail({
      allowedDomain: "localhost",
      attendees: [],
      listing,
    });
    assert(!html.includes("Money in and out"));
    assert(!html.includes('href="/admin/ledger?listing=7"'));
  });

  test("shows money in, money out, and the net result with consistent signs", () => {
    const html = renderListingDetail({
      allowedDomain: "localhost",
      attendees: [],
      listing,
      moneyTotals: {
        externalCosts: 0,
        externalIncome: 0,
        grossSales: 10000,
        manualAdjustments: -1000,
        netBalance: 7000,
        recognisedIncome: 9000,
        refunds: 2000,
        servicingCosts: 0,
        transferCount: 3,
      },
    });
    says(html, "Money in and out");
    // Gross sales credited (+), manual write-down (−), then the two subtotals.
    says(html, "Gross ticket sales");
    says(html, "+£100");
    says(html, "Income corrections");
    says(html, "−£10");
    says(html, "Total income earned");
    says(html, "£90");
    says(html, "Refunds");
    says(html, "−£20");
    says(html, "Net after refunds and costs");
    says(html, "£70");
    // The plain-English reconciliation note and the button to the filtered
    // ledger, preselected to this listing (no arrow glyph, button-styled).
    says(html, "Income is what this listing earned before refunds");
    says(html, 'href="/admin/ledger?listing=7"');
    says(html, "View all money changes");
    assert(!html.includes("View all money changes →"));
  });

  test("makes a refund-driven divergence between income and net balance visible", () => {
    // Recognised income (£90) and the net ledger balance (£70) legitimately
    // differ after a refund; both must render so the reconciliation is shown.
    const html = renderListingDetail({
      allowedDomain: "localhost",
      attendees: [],
      listing,
      moneyTotals: {
        externalCosts: 0,
        externalIncome: 0,
        grossSales: 9000,
        manualAdjustments: 0,
        netBalance: 7000,
        recognisedIncome: 9000,
        refunds: 2000,
        servicingCosts: 0,
        transferCount: 2,
      },
    });
    const recognisedIdx = html.indexOf("Total income earned");
    const netIdx = html.indexOf("Net after refunds and costs");
    expect(recognisedIdx).toBeGreaterThan(-1);
    expect(netIdx).toBeGreaterThan(-1);
    expect(netIdx).toBeGreaterThan(recognisedIdx);
    says(html, "£90");
    says(html, "£70");
    // The two figures differ exactly by the refunds line.
    says(html, "−£20");
  });

  test("omits the manual-adjustments row when there are none", () => {
    const html = renderListingDetail({
      allowedDomain: "localhost",
      attendees: [],
      listing,
      moneyTotals: {
        externalCosts: 0,
        externalIncome: 0,
        grossSales: 5000,
        manualAdjustments: 0,
        netBalance: 5000,
        recognisedIncome: 5000,
        refunds: 0,
        servicingCosts: 0,
        transferCount: 1,
      },
    });
    says(html, "Money in and out");
    assert(!html.includes("Income corrections"));
    // With no refunds either, recognised income and net balance coincide at £50.
    says(html, "Total income earned");
    says(html, "Net after refunds and costs");
    says(html, "£50");
  });

  test("shows a signed positive manual write-up", () => {
    const html = renderListingDetail({
      allowedDomain: "localhost",
      attendees: [],
      listing,
      moneyTotals: {
        externalCosts: 0,
        externalIncome: 0,
        grossSales: 4000,
        manualAdjustments: 1500,
        netBalance: 5500,
        recognisedIncome: 5500,
        refunds: 0,
        servicingCosts: 0,
        transferCount: 2,
      },
    });
    says(html, "Income corrections");
    says(html, "+£15");
  });

  test("shows outside income and listing-specific costs when present", () => {
    const html = renderListingDetail({
      allowedDomain: "localhost",
      attendees: [],
      listing,
      moneyTotals: {
        externalCosts: 300,
        externalIncome: 1200,
        grossSales: 4000,
        manualAdjustments: 0,
        netBalance: 4900,
        recognisedIncome: 5200,
        refunds: 0,
        servicingCosts: 0,
        transferCount: 3,
      },
    });
    says(html, "Income received outside checkout");
    says(html, "+£12");
    says(html, "Costs paid outside checkout");
    says(html, "−£3");
  });
});

describe("overviewStatsFromDbStats", () => {
  registerListingTemplateHooks();

  const dbStats = {
    completeQuantitySum: 5,
    incompleteQuantity: 2,
    incompleteSales: 300,
    rowsCheckedIn: 1,
    rowsTotal: 3,
    ticketsCheckedIn: 2,
    ticketsTotal: 4,
  };

  test("subtracts incomplete count and unpaid sales for a paid listing", () => {
    const view = overviewStatsFromDbStats(dbStats, 7, 2100, true);
    expect(view.adjustedCount).toBe(5); // 7 booked − 2 incomplete
    expect(view.completeQuantitySum).toBe(5);
    expect(view.completeRevenue).toBe(1800); // 2100 gross − 300 unpaid
    expect(view.checkedInStats).toEqual({
      hasMultiQuantity: true, // ticketsTotal 4 ≠ rowsTotal 3
      rowsCheckedIn: 1,
      rowsTotal: 3,
      ticketsCheckedIn: 2,
      ticketsTotal: 4,
    });
  });

  test("reports zero revenue for a free listing and flat multi-quantity", () => {
    const flat = { ...dbStats, rowsTotal: 4, ticketsTotal: 4 };
    const view = overviewStatsFromDbStats(flat, 6, 999, false);
    expect(view.completeRevenue).toBe(0);
    expect(view.checkedInStats.hasMultiQuantity).toBe(false);
  });
});
