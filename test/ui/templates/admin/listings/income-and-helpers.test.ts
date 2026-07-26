import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { isIncompletePayment } from "#shared/incomplete-payment.ts";
import { nearCapacity } from "#templates/admin/listings/aggregates.tsx";
import { completePaymentAttendees } from "#templates/admin/listings/attendees.tsx";
import { overviewStatsFromDbStats } from "#templates/admin/listings/overview.tsx";
import { getListingForm } from "#templates/fields/listing.ts";
import {
  registerListingTemplateHooks,
  renderListingDetail,
} from "#test/ui/templates/admin/listings/helpers.ts";
import { testAttendee, testListingWithCount } from "#test-utils/factories.ts";

describe("adminListingPage money breakdown", () => {
  registerListingTemplateHooks();

  const listing = testListingWithCount({ id: 7 });

  test("omits the section entirely when no breakdown is supplied", () => {
    const html = renderListingDetail({
      allowedDomain: "localhost",
      attendees: [],
      listing,
    });
    expect(html).not.toContain("Money in and out");
    expect(html).not.toContain('href="/admin/ledger?listing=7"');
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
    expect(html).toContain("Money in and out");
    // Gross sales credited (+), manual write-down (−), then the two subtotals.
    expect(html).toContain("Gross ticket sales");
    expect(html).toContain("+£100");
    expect(html).toContain("Income corrections");
    expect(html).toContain("−£10");
    expect(html).toContain("Total income earned");
    expect(html).toContain("£90");
    expect(html).toContain("Refunds");
    expect(html).toContain("−£20");
    expect(html).toContain("Net after refunds and costs");
    expect(html).toContain("£70");
    // The plain-English reconciliation note and the button to the filtered
    // ledger, preselected to this listing (no arrow glyph, button-styled).
    expect(html).toContain("Income is what this listing earned before refunds");
    expect(html).toContain('href="/admin/ledger?listing=7"');
    expect(html).toContain("View all money changes");
    expect(html).not.toContain("View all money changes →");
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
    expect(html).toContain("£90");
    expect(html).toContain("£70");
    // The two figures differ exactly by the refunds line.
    expect(html).toContain("−£20");
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
    expect(html).toContain("Money in and out");
    expect(html).not.toContain("Income corrections");
    // With no refunds either, recognised income and net balance coincide at £50.
    expect(html).toContain("Total income earned");
    expect(html).toContain("Net after refunds and costs");
    expect(html).toContain("£50");
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
    expect(html).toContain("Income corrections");
    expect(html).toContain("+£15");
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
    expect(html).toContain("Income received outside checkout");
    expect(html).toContain("+£12");
    expect(html).toContain("Costs paid outside checkout");
    expect(html).toContain("−£3");
  });
});

describe("nearCapacity", () => {
  registerListingTemplateHooks();

  test("returns true when at 90% capacity", () => {
    const listing = testListingWithCount({
      attendee_count: 90,
      max_attendees: 100,
    });
    expect(nearCapacity(listing)).toBe(true);
  });

  test("returns true when over 90% capacity", () => {
    const listing = testListingWithCount({
      attendee_count: 95,
      max_attendees: 100,
    });
    expect(nearCapacity(listing)).toBe(true);
  });

  test("returns false when under 90% capacity", () => {
    const listing = testListingWithCount({
      attendee_count: 89,
      max_attendees: 100,
    });
    expect(nearCapacity(listing)).toBe(false);
  });

  test("returns true when fully sold out", () => {
    const listing = testListingWithCount({
      attendee_count: 100,
      max_attendees: 100,
    });
    expect(nearCapacity(listing)).toBe(true);
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

describe("isIncompletePayment", () => {
  registerListingTemplateHooks();

  test("returns true for paid listing attendee with no payment_id and price > 0", () => {
    const attendee = testAttendee({ payment_id: "", price_paid: "1000" });
    expect(isIncompletePayment(attendee, true, false)).toBe(true);
  });

  test("returns false for free listing", () => {
    const attendee = testAttendee({ payment_id: "", price_paid: "0" });
    expect(isIncompletePayment(attendee, false, false)).toBe(false);
  });

  test("returns false for admin-added attendee on paid listing (price_paid=0)", () => {
    const attendee = testAttendee({ payment_id: "", price_paid: "0" });
    expect(isIncompletePayment(attendee, true, false)).toBe(false);
  });

  test("returns false for completed payment attendee", () => {
    const attendee = testAttendee({
      payment_id: "pi_test_123",
      price_paid: "1000",
    });
    expect(isIncompletePayment(attendee, true, true)).toBe(false);
  });

  test("returns false when an empty-payment-id attendee has a processed reference", () => {
    const attendee = testAttendee({ payment_id: "", price_paid: "1000" });
    expect(isIncompletePayment(attendee, true, true)).toBe(false);
  });

  test("returns false for refunded paid attendee with no surviving payment reference", () => {
    const attendee = testAttendee({
      payment_id: "",
      price_paid: "1000",
      refunded: true,
    });
    expect(isIncompletePayment(attendee, true, false)).toBe(false);
  });

  test("returns true for a one-unit paid attendee with no payment reference", () => {
    // Probes the boundary of `price_paid > 0`: distinguish > 0 from > 1.
    const attendee = testAttendee({ payment_id: "", price_paid: "1" });
    expect(isIncompletePayment(attendee, true, false)).toBe(true);
  });

  test("returns false when the attendee still owes money", () => {
    // Probes the boundary of `remaining_balance <= 0`: distinguish <= 0 from
    // <= 1. Someone who paid part but still owes is not an incomplete payment.
    const attendee = testAttendee({
      payment_id: "",
      price_paid: "1000",
      remaining_balance: 1,
    });
    expect(isIncompletePayment(attendee, true, false)).toBe(false);
  });
});

describe("completePaymentAttendees", () => {
  registerListingTemplateHooks();

  test("drops unresolved-payment rows on a paid listing", () => {
    const listing = testListingWithCount({ unit_price: 1000 });
    const paid = testAttendee({
      id: 1,
      payment_id: "pi_ok",
      price_paid: "1000",
    });
    const failed = testAttendee({ id: 2, payment_id: "", price_paid: "1000" });
    expect(completePaymentAttendees(listing, [paid, failed])).toEqual([paid]);
  });

  test("keeps an empty-payment-id attendee with a processed reference", () => {
    const listing = testListingWithCount({ unit_price: 1000 });
    const balancePaid = testAttendee({
      id: 2,
      payment_id: "",
      price_paid: "1000",
    });
    expect(
      completePaymentAttendees(listing, [balancePaid], new Set([2])),
    ).toEqual([balancePaid]);
  });

  test("keeps every row on a free listing", () => {
    const listing = testListingWithCount({ unit_price: 0 });
    const a = testAttendee({ id: 1, payment_id: "", price_paid: "0" });
    const b = testAttendee({ id: 2, payment_id: "", price_paid: "1000" });
    expect(completePaymentAttendees(listing, [a, b])).toEqual([a, b]);
  });
});

describe("datetime validation via listing form date field", () => {
  registerListingTemplateHooks();

  const dateField = getListingForm().fields.find((f) => f.name === "date")!;

  test("accepts valid datetime value", () => {
    const result = dateField.validate?.("2026-06-15T14:00");
    expect(result).toBeNull();
  });

  test("rejects invalid datetime value", () => {
    const result = dateField.validate?.("not-a-date");
    expect(result).toBe("Please enter a valid date and time");
  });
});
