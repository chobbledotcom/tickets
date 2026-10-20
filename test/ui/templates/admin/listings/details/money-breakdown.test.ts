import { assert, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { overviewStatsFromDbStats } from "#templates/admin/listings/overview.tsx";
import {
  registerListingTemplateHooks,
  renderListingDetail,
} from "#test/ui/templates/admin/listings/helpers.ts";
import { testListingWithCount } from "#test-utils/factories.ts";

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
    assertStringIncludes(html, "Money in and out");
    // Gross sales credited (+), manual write-down (−), then the two subtotals.
    assertStringIncludes(html, "Gross ticket sales");
    assertStringIncludes(html, "+£100");
    assertStringIncludes(html, "Income corrections");
    assertStringIncludes(html, "−£10");
    assertStringIncludes(html, "Total income earned");
    assertStringIncludes(html, "£90");
    assertStringIncludes(html, "Refunds");
    assertStringIncludes(html, "−£20");
    assertStringIncludes(html, "Net after refunds and costs");
    assertStringIncludes(html, "£70");
    // The plain-English reconciliation note and the button to the filtered
    // ledger, preselected to this listing (no arrow glyph, button-styled).
    assertStringIncludes(
      html,
      "Income is what this listing earned before refunds",
    );
    assertStringIncludes(html, 'href="/admin/ledger?listing=7"');
    assertStringIncludes(html, "View all money changes");
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
    assertStringIncludes(html, "£90");
    assertStringIncludes(html, "£70");
    // The two figures differ exactly by the refunds line.
    assertStringIncludes(html, "−£20");
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
    assertStringIncludes(html, "Money in and out");
    assert(!html.includes("Income corrections"));
    // With no refunds either, recognised income and net balance coincide at £50.
    assertStringIncludes(html, "Total income earned");
    assertStringIncludes(html, "Net after refunds and costs");
    assertStringIncludes(html, "£50");
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
    assertStringIncludes(html, "Income corrections");
    assertStringIncludes(html, "+£15");
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
    assertStringIncludes(html, "Income received outside checkout");
    assertStringIncludes(html, "+£12");
    assertStringIncludes(html, "Costs paid outside checkout");
    assertStringIncludes(html, "−£3");
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
