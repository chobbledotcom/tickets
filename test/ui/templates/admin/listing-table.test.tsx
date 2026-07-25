import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { columnOrThrow } from "#shared/tables/definition.ts";
import type { ListingWithCount } from "#shared/types.ts";
import {
  ListingsTableBlock,
  listingTable,
  renderListingsTableSection,
} from "#templates/admin/listing-table.tsx";
import { setupAdminPageTest } from "#test-utils/admin-page-test.ts";
import { testListingWithCount } from "#test-utils/factories.ts";

const rawValue = (key: string, listing: ListingWithCount): unknown => {
  const read = columnOrThrow(listingTable, key).rawValue;
  if (read === undefined) throw new Error(`Column ${key} has no raw value`);
  return read(listing, undefined);
};

const cell = (key: string, listing: ListingWithCount): string =>
  String(
    columnOrThrow(listingTable, key).cell(listing, undefined, 0, [listing]),
  );

describe("listingTable", () => {
  beforeAll(setupAdminPageTest);

  test("returns the stored values used by Liquid filters", () => {
    const listing = testListingWithCount({
      cost: 200,
      date: "2026-04-10",
      income: 1200,
      months_per_unit: 12,
      name: "Gala",
      profit: 1000,
      tickets_count: 7,
      unit_price: 450,
    });

    expect(
      [
        "name",
        "tickets",
        "revenue",
        "cost",
        "profit",
        "date",
        "price",
        "renewal",
      ].map((key) => rawValue(key, listing)),
    ).toEqual(["Gala", 7, 1200, 200, 1000, "2026-04-10", 450, 12]);
  });

  test("returns an empty raw date when the listing has no date", () => {
    expect(rawValue("date", testListingWithCount({ date: "" }))).toBe("");
  });

  test("renders optional listing values", () => {
    const listing = testListingWithCount({
      date: "2026-04-10",
      location: "Town Hall",
      months_per_unit: 12,
      unit_price: 450,
    });

    expect(cell("date", listing)).toContain("2026");
    expect(cell("date", testListingWithCount({ date: "" }))).toBe("");
    expect(cell("location", listing)).toBe("Town Hall");
    expect(cell("price", listing)).toBe("450");
    expect(cell("price", testListingWithCount({ unit_price: 0 }))).toBe("Free");
    expect(cell("renewal", listing)).toBe("Renewal (12 months)");
    expect(cell("renewal", testListingWithCount({ months_per_unit: 0 }))).toBe(
      "",
    );
  });

  test("renders an explicit column selection", () => {
    const html = String(
      renderListingsTableSection({
        columnKeys: ["location"],
        emptyText: "None",
        listings: [testListingWithCount({ location: "Town Hall" })],
      }),
    );

    expect(html).toContain("<th>Location</th>");
    expect(html).toContain("<td>Town Hall</td>");
    expect(html).not.toContain("Listing name");
  });

  test("uses the requested CSV export path", () => {
    const html = String(
      ListingsTableBlock({
        csvExport: true,
        csvHref: "/custom.csv",
        listings: [],
      }),
    );

    expect(html).toContain('href="/custom.csv"');
    expect(html).not.toContain('href="/admin/listings/csv"');
  });

  test("uses the default CSV export path", () => {
    const html = String(ListingsTableBlock({ csvExport: true, listings: [] }));

    expect(html).toContain('href="/admin/listings/csv"');
  });
});
