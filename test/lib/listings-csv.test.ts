import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { generateListingsCsv } from "#routes/admin/listings-csv.ts";
import { signCsrfToken } from "#shared/csrf.ts";
import { setupTestEncryptionKey, testListingWithCount } from "#test-utils";

beforeAll(async () => {
  setupTestEncryptionKey();
  await signCsrfToken();
});

describe("generateListingsCsv", () => {
  test("emits the header row when there are no listings", () => {
    expect(generateListingsCsv([])).toBe(
      "Name,Status,Type,Attendees,Capacity,Tickets,Revenue,Price,Date,Location,Created,Description",
    );
  });

  test("renders a listing's values in column order", () => {
    const csv = generateListingsCsv([
      testListingWithCount({
        attendee_count: 4,
        created: "2026-01-02T00:00:00Z",
        date: "2026-06-15T18:00:00Z",
        description: "A fun night",
        income: 5000,
        location: "Village Hall",
        max_attendees: 50,
        name: "Gala Night",
        tickets_count: 3,
        unit_price: 2000,
      }),
    ]);
    expect(csv.split("\n")[1]).toBe(
      // 18:00 UTC = 19:00 BST (default timezone Europe/London)
      "Gala Night,Active,Standard,4,50,3,50.00,20.00,2026-06-15 19:00,Village Hall,2026-01-02T00:00:00.000Z,A fun night",
    );
  });

  test("shows Free for a zero-price listing and Inactive status", () => {
    const csv = generateListingsCsv([
      testListingWithCount({ active: false, name: "Freebie", unit_price: 0 }),
    ]);
    expect(csv).toContain("Freebie,Inactive,");
    expect(csv).toContain(",Free,");
  });

  test("shows the day-price range for a paid customisable-days listing", () => {
    const csv = generateListingsCsv([
      testListingWithCount({
        customisable_days: true,
        day_prices: { 1: 1000, 3: 3000 },
        duration_days: 3,
        name: "Camp",
        unit_price: 0,
      }),
    ]);
    expect(csv).toContain("10.00–30.00");
    expect(csv).not.toContain("Free");
  });

  test("shows a single day price when only one duration is offered", () => {
    const csv = generateListingsCsv([
      testListingWithCount({
        customisable_days: true,
        day_prices: { 2: 1500 },
        duration_days: 2,
        unit_price: 0,
      }),
    ]);
    expect(csv).toContain(",15.00,");
    expect(csv).not.toContain("Free");
  });

  test("shows the pay-what-you-want range instead of Free for can_pay_more", () => {
    // can_pay_more listings are paid even with a zero base price: buyers may
    // pay up to max_price, so the CSV must not report them as Free.
    const csv = generateListingsCsv([
      testListingWithCount({
        can_pay_more: true,
        max_price: 5000,
        name: "Donate",
        unit_price: 0,
      }),
    ]);
    expect(csv).toContain("0.00–50.00");
    expect(csv).not.toContain("Free");
  });

  test("shows the pay-what-you-want range from a non-zero base price", () => {
    const csv = generateListingsCsv([
      testListingWithCount({
        can_pay_more: true,
        max_price: 5000,
        unit_price: 2000,
      }),
    ]);
    expect(csv).toContain("20.00–50.00");
  });

  test("uses day prices for a customisable listing with a non-zero base price", () => {
    // Checkout charges from day_prices; the legacy unit_price must be ignored.
    const csv = generateListingsCsv([
      testListingWithCount({
        customisable_days: true,
        day_prices: { 1: 1000, 2: 1800 },
        duration_days: 2,
        unit_price: 5000,
      }),
    ]);
    expect(csv).toContain("10.00–18.00");
    expect(csv).not.toContain("50.00");
  });

  test("labels a daily listing's type", () => {
    const csv = generateListingsCsv([
      testListingWithCount({ listing_type: "daily", name: "Day Pass" }),
    ]);
    expect(csv.split("\n")[1]).toContain("Day Pass,Active,Daily,");
  });

  test("escapes a listing name containing a comma", () => {
    const csv = generateListingsCsv([
      testListingWithCount({ name: "Wine, Cheese" }),
    ]);
    expect(csv).toContain('"Wine, Cheese"');
  });

  test("renders the Date column (with time) in the configured timezone", () => {
    // 23:30 UTC is 00:30 the next calendar day in Europe/London (BST, UTC+1).
    const listing = testListingWithCount({ date: "2026-06-15T23:30:00Z" });
    expect(
      generateListingsCsv([listing], "Europe/London").split("\n")[1],
    ).toContain(",2026-06-16 00:30,");
    expect(generateListingsCsv([listing], "UTC").split("\n")[1]).toContain(
      ",2026-06-15 23:30,",
    );
  });
});
