import { assert, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { generateListingsCsv } from "#routes/admin/listings-csv.ts";
import { setupAdminPageTest } from "#test-utils/admin-page-test.ts";
import { expectIncludesAll } from "#test-utils/assertions.ts";
import { testListingWithCount } from "#test-utils/factories.ts";

describe("generateListingsCsv", () => {
  beforeAll(setupAdminPageTest);

  test("emits the header row when there are no listings", () => {
    expect(generateListingsCsv([])).toBe(
      "Name,Status,Type,Attendees,Capacity,Tickets,Revenue,Price,Date,Location,Created,Description",
    );
  });

  test("renders a listing's values in column order", () => {
    const csv = generateListingsCsv([
      testListingWithCount({
        attendeeCount: 4,
        created: "2026-01-02T00:00:00Z",
        date: "2026-06-15T18:00:00Z",
        description: "A fun night",
        income: 5000,
        location: "Village Hall",
        maxAttendees: 50,
        name: "Gala Night",
        ticketsCount: 3,
        unitPrice: 2000,
      }),
    ]);
    expect(csv.split("\n")[1]).toBe(
      // 18:00 UTC = 19:00 BST (default timezone Europe/London)
      "Gala Night,Active,Standard,4,50,3,50.00,20.00,2026-06-15 19:00,Village Hall,2026-01-02T00:00:00.000Z,A fun night",
    );
  });

  test("shows Free for a zero-price listing and Inactive status", () => {
    const csv = generateListingsCsv([
      testListingWithCount({ active: false, name: "Freebie", unitPrice: 0 }),
    ]);
    expectIncludesAll(csv, ["Freebie,Inactive,", ",Free,"]);
  });

  test("shows the day-price range for a paid customisable-days listing", () => {
    const csv = generateListingsCsv([
      testListingWithCount({
        customisableDays: true,
        dayPrices: { 1: 1000, 3: 3000 },
        durationDays: 3,
        name: "Camp",
        unitPrice: 0,
      }),
    ]);
    assertStringIncludes(csv, "10.00–30.00");
    assert(!csv.includes("Free"));
  });

  test("shows a single day price when only one duration is offered", () => {
    const csv = generateListingsCsv([
      testListingWithCount({
        customisableDays: true,
        dayPrices: { 2: 1500 },
        durationDays: 2,
        unitPrice: 0,
      }),
    ]);
    assertStringIncludes(csv, ",15.00,");
    assert(!csv.includes("Free"));
  });

  test("shows the pay-what-you-want range instead of Free for can_pay_more", () => {
    // can_pay_more listings are paid even with a zero base price: buyers may
    // pay up to max_price, so the CSV must not report them as Free.
    const csv = generateListingsCsv([
      testListingWithCount({
        canPayMore: true,
        maxPrice: 5000,
        name: "Donate",
        unitPrice: 0,
      }),
    ]);
    assertStringIncludes(csv, "0.00–50.00");
    assert(!csv.includes("Free"));
  });

  test("shows the pay-what-you-want range from a non-zero base price", () => {
    const csv = generateListingsCsv([
      testListingWithCount({
        canPayMore: true,
        maxPrice: 5000,
        unitPrice: 2000,
      }),
    ]);
    assertStringIncludes(csv, "20.00–50.00");
  });

  test("uses day prices for a customisable listing with a non-zero base price", () => {
    // Checkout charges from day_prices; the legacy unit_price must be ignored.
    const csv = generateListingsCsv([
      testListingWithCount({
        customisableDays: true,
        dayPrices: { 1: 1000, 2: 1800 },
        durationDays: 2,
        unitPrice: 5000,
      }),
    ]);
    assertStringIncludes(csv, "10.00–18.00");
    assert(!csv.includes("50.00"));
  });

  test("labels a daily listing's type", () => {
    const csv = generateListingsCsv([
      testListingWithCount({ listingType: "daily", name: "Day Pass" }),
    ]);
    assertStringIncludes(csv.split("\n")[1] ?? "", "Day Pass,Active,Daily,");
  });

  test("escapes a listing name containing a comma", () => {
    const csv = generateListingsCsv([
      testListingWithCount({ name: "Wine, Cheese" }),
    ]);
    assertStringIncludes(csv, '"Wine, Cheese"');
  });

  test("renders the Date column (with time) in the configured timezone", () => {
    // 23:30 UTC is 00:30 the next calendar day in Europe/London (BST, UTC+1).
    const listing = testListingWithCount({ date: "2026-06-15T23:30:00Z" });
    assertStringIncludes(
      generateListingsCsv([listing], "Europe/London").split("\n")[1] ?? "",
      ",2026-06-16 00:30,",
    );
    assertStringIncludes(
      generateListingsCsv([listing], "UTC").split("\n")[1] ?? "",
      ",2026-06-15 23:30,",
    );
  });
});
