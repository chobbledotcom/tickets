import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { formatCurrency } from "#shared/currency.ts";
import {
  configurableTableLayouts,
  type ListingColumnKey,
} from "#shared/tables/configurable.ts";
import { columnOrThrow } from "#shared/tables/definition.ts";
import {
  ListingsTableBlock,
  listingTable,
  renderListingsTableSection,
} from "#templates/admin/listing-table.tsx";
import { AttendeeTable } from "#templates/attendee-table/component.tsx";
import { setupAdminPageTest } from "#test-utils/admin-page-test.ts";
import { testListingWithCount } from "#test-utils/factories.ts";
import type { ListingWithCount } from "#types";

const rawValue = (
  key: ListingColumnKey,
  listing: ListingWithCount,
): unknown => {
  const read = columnOrThrow(listingTable, key).rawValue;
  if (read === undefined) throw new Error(`Column ${key} has no raw value`);
  return read(listing, undefined);
};

const cell = (key: ListingColumnKey, listing: ListingWithCount): string =>
  String(
    columnOrThrow(listingTable, key).cell(listing, undefined, 0, [listing]),
  );

describe("listingTable", () => {
  beforeAll(setupAdminPageTest);

  test("keeps configurable table keys separate at compile time", () => {
    const renderAttendees = () =>
      AttendeeTable({
        allowedDomain: "example.com",
        // @ts-expect-error Listing layouts cannot be passed to AttendeeTable.
        columnLayout: configurableTableLayouts.listing.defaultLayout,
        rows: [],
        showDate: false,
        showListing: false,
      });
    const renderListings = () =>
      renderListingsTableSection({
        // @ts-expect-error Attendee keys cannot be passed to listing table options.
        columnKeys: configurableTableLayouts.attendee.defaultColumnKeys,
        emptyText: "None",
        listings: [],
      });
    const renderInvalidEditorColumns = () =>
      // @ts-expect-error Editor tables cannot render staff-only columns.
      renderListingsTableSection({
        columnKeys: ["revenue"],
        emptyText: "None",
        listings: [],
        table: "editor",
      });

    void renderAttendees;
    void renderInvalidEditorColumns;
    void renderListings;
  });

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
      (
        [
          "tickets",
          "revenue",
          "cost",
          "profit",
          "date",
          "price",
          "renewal",
        ] as const
      ).map((key) => rawValue(key, listing)),
    ).toEqual([7, 1200, 200, 1000, "2026-04-10", 450, 12]);
  });

  test("returns an empty raw date when the listing has no date", () => {
    expect(rawValue("date", testListingWithCount({ date: "" }))).toBe("");
  });

  test("renders optional listing values", () => {
    const listing = testListingWithCount({
      created: "2026-04-05T12:00:00Z",
      date: "2026-04-10",
      location: "Town Hall",
      months_per_unit: 12,
      unit_price: 450,
    });

    expect(cell("created", listing)).toBe("Sunday 5 April 2026");
    expect(cell("date", listing)).toBe("Friday 10 April 2026");
    expect(cell("date", testListingWithCount({ date: "" }))).toBe("");
    expect(cell("location", listing)).toBe("Town Hall");
    expect(cell("price", listing)).toBe(formatCurrency(450));
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

  test("renders a supported editor column", () => {
    const html = String(
      renderListingsTableSection({
        columnKeys: ["name"],
        emptyText: "None",
        listings: [testListingWithCount({ id: 7, name: "Gala" })],
        table: "editor",
      }),
    );

    expect(html).toContain('<a href="/admin/listing/7/edit">Gala</a>');
    expect(html).not.toContain("Revenue");
  });

  test("marks inactive listing rows", () => {
    const html = String(
      renderListingsTableSection({
        emptyText: "None",
        listings: [testListingWithCount({ active: false, name: "Past" })],
      }),
    );

    expect(html).toContain('<tr class="inactive-row">');
  });

  test("keeps the linked thumbnail when a name filter is present", () => {
    const html = String(
      renderListingsTableSection({
        columnKeys: ["name"],
        emptyText: "None",
        filters: new Map([["name", "name | upcase"]]),
        listings: [
          testListingWithCount({
            id: 7,
            image_url: "https://example.com/gala.jpg",
            name: "Gala",
          }),
        ],
      }),
    );

    expect(html).toContain("listing-thumbnail");
    expect(html).toContain('<a href="/admin/listing/7">Gala</a>');
    expect(html).not.toContain(">GALA<");
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
