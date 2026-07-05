import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { LISTING_TABLE_COLUMNS } from "#shared/columns/listing-columns.ts";
import { testListingWithCount } from "#test-utils";

describe("LISTING_TABLE_COLUMNS cell renderers", () => {
  const u = undefined as unknown;

  test("date cell formats date for display", () => {
    const col = LISTING_TABLE_COLUMNS.date!;
    expect(
      col.cell(testListingWithCount({ date: "2026-04-10T19:00:00Z" }), u),
    ).toContain("2026");
  });

  test("date cell renders empty for missing date", () => {
    const col = LISTING_TABLE_COLUMNS.date!;
    expect(col.cell(testListingWithCount({ date: "" }), u)).toBe("");
  });

  test("date rawValue returns date for Liquid filters", () => {
    expect(
      LISTING_TABLE_COLUMNS.date!.rawValue!(
        testListingWithCount({ date: "2026-04-10" }),
        u,
      ),
    ).toBe("2026-04-10");
  });

  test("date rawValue returns empty for missing date", () => {
    expect(
      LISTING_TABLE_COLUMNS.date!.rawValue!(
        testListingWithCount({ date: "" }),
        u,
      ),
    ).toBe("");
  });

  test("price cell renders numeric string for non-zero price", () => {
    expect(
      LISTING_TABLE_COLUMNS.price!.cell(
        testListingWithCount({ unit_price: 2500 }),
        u,
      ),
    ).toBe("2500");
  });

  test("price cell renders Free for zero price", () => {
    expect(
      LISTING_TABLE_COLUMNS.price!.cell(
        testListingWithCount({ unit_price: 0 }),
        u,
      ),
    ).toBe("Free");
  });

  test("status cell shows Active or Inactive", () => {
    expect(
      LISTING_TABLE_COLUMNS.status!.cell(
        testListingWithCount({ active: true }),
        u,
      ),
    ).toBe("Active");
    expect(
      LISTING_TABLE_COLUMNS.status!.cell(
        testListingWithCount({ active: false }),
        u,
      ),
    ).toBe("Inactive");
  });

  test("attendees cell shows count vs capacity", () => {
    expect(
      LISTING_TABLE_COLUMNS.attendees!.cell(
        testListingWithCount({ attendee_count: 5, max_attendees: 20 }),
        u,
      ),
    ).toBe("5 / 20");
  });

  test("tickets cell shows the tickets_count value", () => {
    expect(
      LISTING_TABLE_COLUMNS.tickets!.cell(
        testListingWithCount({ tickets_count: 7 }),
        u,
      ),
    ).toBe("7");
  });

  test("tickets rawValue returns tickets_count", () => {
    expect(
      LISTING_TABLE_COLUMNS.tickets!.rawValue!(
        testListingWithCount({ tickets_count: 7 }),
        u,
      ),
    ).toBe(7);
  });

  test("revenue cell formats income as currency", () => {
    expect(
      LISTING_TABLE_COLUMNS.revenue!.cell(
        testListingWithCount({ income: 7500 }),
        u,
      ),
    ).toContain("75");
  });

  test("revenue rawValue returns income", () => {
    expect(
      LISTING_TABLE_COLUMNS.revenue!.rawValue!(
        testListingWithCount({ income: 7500 }),
        u,
      ),
    ).toBe(7500);
  });

  test("cost cell formats servicing cost as currency", () => {
    expect(
      LISTING_TABLE_COLUMNS.cost!.cell(testListingWithCount({ cost: 2500 }), u),
    ).toContain("25");
  });

  test("cost rawValue returns cost", () => {
    expect(
      LISTING_TABLE_COLUMNS.cost!.rawValue!(
        testListingWithCount({ cost: 2500 }),
        u,
      ),
    ).toBe(2500);
  });

  test("profit cell formats income less cost as currency", () => {
    expect(
      LISTING_TABLE_COLUMNS.profit!.cell(
        testListingWithCount({ profit: 5000 }),
        u,
      ),
    ).toContain("50");
  });

  test("profit rawValue returns profit", () => {
    expect(
      LISTING_TABLE_COLUMNS.profit!.rawValue!(
        testListingWithCount({ profit: 5000 }),
        u,
      ),
    ).toBe(5000);
  });

  test("renewal cell renders label with months when months_per_unit > 0", () => {
    expect(
      LISTING_TABLE_COLUMNS.renewal!.cell(
        testListingWithCount({ months_per_unit: 3 }),
        u,
      ),
    ).toBe("Renewal (3mo)");
  });

  test("renewal cell renders empty when months_per_unit is 0", () => {
    expect(
      LISTING_TABLE_COLUMNS.renewal!.cell(
        testListingWithCount({ months_per_unit: 0 }),
        u,
      ),
    ).toBe("");
  });

  test("renewal rawValue returns months_per_unit", () => {
    expect(
      LISTING_TABLE_COLUMNS.renewal!.rawValue!(
        testListingWithCount({ months_per_unit: 6 }),
        u,
      ),
    ).toBe(6);
  });
});
