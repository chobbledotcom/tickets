import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import {
  activeListingStatsSection,
  adminDashboardPage,
  adminListingsPage,
} from "#templates/admin/dashboard.tsx";
import { listingTable } from "#templates/admin/listing-table.tsx";
import {
  OWNER_SESSION,
  setupAdminPageTest,
} from "#test-utils/admin-page-test.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { testAttendee, testListingWithCount } from "#test-utils/factories.ts";
import { withRequestContext } from "#test-utils/request-context.ts";

describe("adminDashboardPage", () => {
  beforeAll(setupAdminPageTest);

  test("renders empty state when no listings", () => {
    const html = adminDashboardPage([], OWNER_SESSION);
    expect(html).toContain("Listings");
    expect(html).toContain("No listings yet");
  });

  test("renders listings table", () => {
    const listings = [testListingWithCount({ attendee_count: 25 })];
    const html = adminDashboardPage(listings, OWNER_SESSION);
    expect(html).toContain("Test Listing");
    expect(html).toContain("25 / 100");
    expect(html).toContain("/admin/listing/1");
  });

  test("displays listing name", () => {
    const listings = [testListingWithCount({ name: "My Test Listing" })];
    const html = adminDashboardPage(listings, OWNER_SESSION);
    expect(html).toContain("My Test Listing");
    expect(html).toContain("Listing name");
  });

  test("renders the add-listing and add-attendee quick actions", () => {
    const html = adminDashboardPage([], OWNER_SESSION);
    expect(html).toContain('href="/admin/listing/new"');
    expect(html).toContain("Add Listing");
    expect(html).toContain('href="/admin/attendees/new"');
    expect(html).toContain("Add Attendee");
  });

  test("does not render the multi-booking link builder", () => {
    const listings = [
      testListingWithCount({ active: true, id: 1, slug: "ab12c" }),
      testListingWithCount({ active: true, id: 2, slug: "cd34e" }),
    ];
    const html = adminDashboardPage(listings, OWNER_SESSION);
    expect(html).not.toContain("Multi-booking link");
    expect(html).not.toContain("data-multi-booking-slug");
  });

  test("includes logout link", async () => {
    await withRequestContext(() => {
      const html = adminDashboardPage([], OWNER_SESSION);
      expect(html).toContain("/admin/logout");
    });
  });

  test("renders newest attendees in an open details element", () => {
    const listings = [testListingWithCount({ id: 1, name: "Gala Night" })];
    const attendees = [
      testAttendee({ id: 1, listing_id: 1, name: "Alice" }),
      testAttendee({ id: 2, listing_id: 1, name: "Bob" }),
    ];
    const html = adminDashboardPage(
      listings,
      OWNER_SESSION,
      undefined,
      attendees,
    );
    expect(html).toContain("<details open");
    expect(html).toContain("Newest 2 Attendees");
  });

  test("newest attendees section not shown when no attendees", () => {
    const html = adminDashboardPage([], OWNER_SESSION, undefined, []);
    expect(html).not.toContain("Newest");
    expect(html).not.toContain("<details open");
  });
  test("renders upcoming holidays in a constrained scrollable table", () => {
    const html = adminDashboardPage(
      [],
      OWNER_SESSION,
      undefined,
      [],
      undefined,
      undefined,
      undefined,
      "all",
      [
        {
          end_date: "2026-12-26",
          id: 1,
          name: "Winter Break",
          start_date: "2026-12-24",
        },
      ],
    );

    expect(html).toContain("Upcoming holidays</summary>");
    expect(html).toContain('class="table-scroll dashboard-holidays-scroll"');
    expect(html).toContain('href="/admin/holidays/1"');
    expect(html).toContain("Winter Break");
    expect(html).toContain("2026-12-24");
    expect(html).toContain("2026-12-26");
  });

  test("renders upcoming service events with listing details and edit links", () => {
    const listings = [testListingWithCount({ id: 7, name: "Room A" })];
    const html = adminDashboardPage(
      listings,
      OWNER_SESSION,
      undefined,
      [],
      undefined,
      undefined,
      undefined,
      "all",
      [],
      [
        {
          bookings: [{ listingId: 7, quantity: 2 }],
          date: "2099-07-01",
          id: 42,
          name: "Boiler Service",
          totalQuantity: 2,
        },
        {
          bookings: [{ listingId: 999, quantity: 1 }],
          date: null,
          id: 43,
          name: "Unassigned Service",
          totalQuantity: 1,
        },
      ],
    );
    expect(html).toContain("Upcoming service events</summary>");
    expect(html).toContain('href="/admin/servicing/42"');
    expect(html).toContain("Boiler Service");
    expect(html).toContain("2099");
    expect(html).toContain("1 listing · 2");
    expect(html).toContain('href="/admin/servicing/43"');
    expect(html).toContain("Unassigned Service");
  });

  test("newest attendees shows singular for single attendee", () => {
    const listings = [testListingWithCount({ id: 1 })];
    const attendees = [testAttendee({ id: 1, listing_id: 1 })];
    const html = adminDashboardPage(
      listings,
      OWNER_SESSION,
      undefined,
      attendees,
    );
    expect(html).toContain("Newest 1 Attendee</summary>");
  });

  test("newest attendees shows the Listings column", () => {
    const listings = [testListingWithCount({ id: 1, name: "Workshop" })];
    const attendees = [testAttendee({ id: 1, listing_id: 1 })];
    const html = adminDashboardPage(
      listings,
      OWNER_SESSION,
      undefined,
      attendees,
    );
    expect(html).toContain("<th>Listings</th>");
    expect(html).toContain("Workshop");
  });

  test("newest attendees groups an attendee's bookings into one row, listings in display order", () => {
    // `listings` arrives pre-sorted (Gala first); the attendee's lines arrive
    // in the opposite order, so the cell order proves the display order wins.
    const listings = [
      testListingWithCount({ id: 1, name: "Gala" }),
      testListingWithCount({ id: 2, name: "Workshop" }),
    ];
    const attendees = [
      testAttendee({ id: 1, listing_id: 2, name: "Alice" }),
      testAttendee({ id: 1, listing_id: 1, name: "Alice" }),
    ];
    const html = adminDashboardPage(
      listings,
      OWNER_SESSION,
      undefined,
      attendees,
    );
    expect(html).toContain("Newest 1 Attendee</summary>");
    expect(html).toContain(
      '<span class="listings-cell" title="Gala, Workshop">' +
        '<a href="/admin/listing/1">Gala</a>, ' +
        '<a href="/admin/listing/2">Workshop</a></span>',
    );
  });

  test("newest attendees not shown when all attendees have unknown listing_id", () => {
    const listings = [testListingWithCount({ id: 1 })];
    const attendees = [testAttendee({ id: 1, listing_id: 999 })];
    const html = adminDashboardPage(
      listings,
      OWNER_SESSION,
      undefined,
      attendees,
    );
    expect(html).not.toContain("Newest");
    expect(html).not.toContain("<details open");
  });

  test("newest attendees skips attendees with unknown listing_id", () => {
    const listings = [testListingWithCount({ id: 1, name: "Known Listing" })];
    const attendees = [
      testAttendee({ id: 1, listing_id: 1, name: "Valid" }),
      testAttendee({ id: 2, listing_id: 999, name: "Orphan" }),
    ];
    const html = adminDashboardPage(
      listings,
      OWNER_SESSION,
      undefined,
      attendees,
    );
    expect(html).toContain("Valid");
    expect(html).not.toContain("Orphan");
    expect(html).toContain("Newest 1 Attendee</summary>");
  });
});

describe("adminDashboardPage inactive listings", () => {
  beforeAll(setupAdminPageTest);

  test("hides inactive listings from home", () => {
    const listings = [
      testListingWithCount({
        active: false,
        attendee_count: 5,
        name: "Inactive",
      }),
    ];
    const html = adminDashboardPage(listings, OWNER_SESSION);
    expect(html).not.toContain("inactive-row");
    expect(html).not.toContain('href="/admin/listing/1"');
    expect(html).toContain("No listings yet");
  });
});

describe("adminDashboardPage with column template filters", () => {
  beforeAll(setupAdminPageTest);

  test("applies date filter to created column", () => {
    const listings = [
      testListingWithCount({ created: "2026-04-10T14:00:00Z" }),
    ];
    const html = adminDashboardPage(
      listings,
      OWNER_SESSION,
      undefined,
      [],
      undefined,
      null,
      listingTable.layout.parse('{{name}}, {{created | date: "%B %Y"}}'),
    );
    expect(html).toContain("April 2026");
  });

  test("renders default cell format when no filter applied", () => {
    const listings = [
      testListingWithCount({ created: "2026-04-10T14:00:00Z" }),
    ];
    const html = adminDashboardPage(
      listings,
      OWNER_SESSION,
      undefined,
      [],
      undefined,
      null,
      listingTable.layout.parse("{{name}}, {{created}}"),
    );
    expect(html).toContain("Friday 10 April 2026");
  });
});

describe("activeListingStatsSection", () => {
  test("renders income, tickets, and attendees", () => {
    const html = activeListingStatsSection({
      attendees: 52,
      income: 5000,
      tickets: 30,
    });
    expect(html).toContain("Active Listing Statistics");
    expect(html).toContain("<strong>Income:</strong>");
    expect(html).toContain("<strong>Tickets:</strong>");
    expect(html).toContain("<strong>Attendees:</strong>");
    expect(html).toContain("30");
    expect(html).toContain("52");
  });

  test("renders zero values", () => {
    const html = activeListingStatsSection({
      attendees: 0,
      income: 0,
      tickets: 0,
    });
    expect(html).toContain("<strong>Tickets:</strong> 0");
    expect(html).toContain("<strong>Attendees:</strong> 0");
  });

  test("renders as closed details element", () => {
    const html = activeListingStatsSection({
      attendees: 0,
      income: 0,
      tickets: 0,
    });
    expect(html).toContain("<details>");
    expect(html).not.toContain("<details open");
  });
});

describe("adminDashboardPage active listing statistics", () => {
  beforeAll(setupAdminPageTest);

  test("shows stats section when stats provided", () => {
    const html = adminDashboardPage(
      [],
      OWNER_SESSION,
      undefined,
      [],
      undefined,
      {
        attendees: 10,
        income: 1000,
        tickets: 5,
      },
    );
    expect(html).toContain("Active Listing Statistics");
  });

  test("does not show stats section when stats is null", () => {
    const html = adminDashboardPage(
      [],
      OWNER_SESSION,
      undefined,
      [],
      undefined,
      null,
    );
    expect(html).not.toContain("Active Listing Statistics");
  });

  test("does not show stats section when stats not provided", () => {
    const html = adminDashboardPage([], OWNER_SESSION);
    expect(html).not.toContain("Active Listing Statistics");
  });
});

describe("adminDashboardPage type filter", () => {
  beforeAll(setupAdminPageTest);

  const standard = testListingWithCount({
    id: 1,
    listing_type: "standard",
    name: "Standard Listing",
    slug: "std01",
  });
  const daily = testListingWithCount({
    id: 2,
    listing_type: "daily",
    name: "Daily Listing",
    slug: "day01",
  });

  test("shows the filter bar when more than one type is present", () => {
    const html = adminDashboardPage([standard, daily], OWNER_SESSION);
    expect(html).toContain("Showing:");
    expect(html).toContain('href="/admin/?type=standard"');
    expect(html).toContain('href="/admin/?type=daily"');
  });

  test("hides the filter bar when only one type is present", () => {
    const onlyStandard = testListingWithCount({
      id: 3,
      listing_type: "standard",
      slug: "std02",
    });
    const html = adminDashboardPage([standard, onlyStandard], OWNER_SESSION);
    expect(html).not.toContain("Showing:");
  });

  test("shows every type and marks 'All' active on the default view", () => {
    const html = adminDashboardPage([standard, daily], OWNER_SESSION);
    expect(html).toContain("Standard Listing");
    expect(html).toContain("Daily Listing");
    expect(html).toContain("<strong><u>All</u></strong>");
  });

  test("filters the listing table to the active type", () => {
    // Standard is inactive, so it never reaches the active-only table.
    const standardInactive = testListingWithCount({
      active: false,
      id: 1,
      listing_type: "standard",
      name: "Standard Listing",
      slug: "std01",
    });
    const html = adminDashboardPage(
      [standardInactive, daily],
      OWNER_SESSION,
      undefined,
      [],
      undefined,
      null,
      undefined,
      "daily",
    );
    expect(html).toContain("Daily Listing");
    expect(html).not.toContain("Standard Listing");
    expect(html).toContain("<strong><u>Daily</u></strong>");
    // The "All" option links back to the unfiltered dashboard.
    expect(html).toContain('<a href="/admin/">All</a>');
  });

  test("does not show a CSV export footer (the dashboard table is active-only)", () => {
    const html = adminDashboardPage([standard, daily], OWNER_SESSION);
    expect(html).not.toContain("/admin/listings/csv");
  });
});

describeWithEnv(
  "listing images",
  { env: { STORAGE_ZONE_KEY: "testkey", STORAGE_ZONE_NAME: "testzone" } },
  () => {
    describe("adminDashboardPage with images", () => {
      beforeAll(setupAdminPageTest);

      test("shows thumbnail when listing has image_url", () => {
        const listings = [testListingWithCount({ image_url: "thumb.jpg" })];
        const html = adminDashboardPage(listings, OWNER_SESSION);
        expect(html).toContain("/image/thumb.jpg");
        expect(html).toContain('class="listing-thumbnail"');
      });

      test("does not show thumbnail when listing has no image_url", () => {
        const listings = [testListingWithCount({ image_url: "" })];
        const html = adminDashboardPage(listings, OWNER_SESSION);
        expect(html).not.toContain('src="/image/');
      });
    });
  },
);

describe("adminListingsPage", () => {
  beforeAll(setupAdminPageTest);

  test("renders active listings first and deactivated listings second", () => {
    const active = testListingWithCount({
      active: true,
      id: 1,
      name: "Active Show",
    });
    const inactive = testListingWithCount({
      active: false,
      id: 2,
      name: "Old Show",
    });
    const html = adminListingsPage([active, inactive], OWNER_SESSION);
    expect(html).toContain('class="active" href="/admin/listings"');
    expect(html).toContain("Active Show");
    expect(html).toContain("Deactivated");
    expect(html).toContain("Old Show");
    expect(html.indexOf("Active Show")).toBeLessThan(html.indexOf("Old Show"));
    // The Listings section sub-nav offers the catalog import entry point.
    expect(html).toContain('href="/admin/catalog/import"');
  });

  test("omits the deactivated heading when every listing is active", () => {
    const html = adminListingsPage(
      [testListingWithCount({ active: true, name: "Active Show" })],
      OWNER_SESSION,
    );
    expect(html).not.toContain("Deactivated");
  });

  test("links to the listings CSV export", () => {
    const html = adminListingsPage(
      [testListingWithCount({ name: "Active Show" })],
      OWNER_SESSION,
    );
    expect(html).toContain('class="table-actions"');
    expect(html).toContain('href="/admin/listings/csv"');
    expect(html).toContain("Export CSV");
  });
});
