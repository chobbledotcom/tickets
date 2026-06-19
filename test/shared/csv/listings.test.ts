import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { signCsrfToken } from "#shared/csrf.ts";
import { generateListingsCsv } from "#shared/csv/listings.ts";
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
      "Gala Night,Active,Standard,4,50,3,50.00,20.00,2026-06-15,Village Hall,2026-01-02T00:00:00.000Z,A fun night",
    );
  });

  test("shows Free for a zero-price listing and Inactive status", () => {
    const csv = generateListingsCsv([
      testListingWithCount({ active: false, name: "Freebie", unit_price: 0 }),
    ]);
    expect(csv).toContain("Freebie,Inactive,");
    expect(csv).toContain(",Free,");
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
});
