import { assert } from "@std/assert";
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
import { says } from "#test-utils/says.ts";

describe("adminDashboardPage", () => {
  beforeAll(setupAdminPageTest);

  test("renders empty state when no listings", () => {
    const html = adminDashboardPage([], OWNER_SESSION);
    says(html, "Listings");
    says(html, "No listings yet");
  });

  test("renders listings table", () => {
    const listings = [testListingWithCount({ attendee_count: 25 })];
    const html = adminDashboardPage(listings, OWNER_SESSION);
    says(html, "Test Listing");
    says(html, "25 / 100");
    says(html, "/admin/listing/1");
  });

  test("displays listing name", () => {
    const listings = [testListingWithCount({ name: "My Test Listing" })];
    const html = adminDashboardPage(listings, OWNER_SESSION);
    says(html, "My Test Listing");
    says(html, "Listing name");
  });

  test("renders the add-listing and add-attendee quick actions", () => {
    const html = adminDashboardPage([], OWNER_SESSION);
    says(html, 'href="/admin/listing/new"');
    says(html, "Add Listing");
    says(html, 'href="/admin/attendees/new"');
    says(html, "Add Attendee");
  });

  test("does not render the multi-booking link builder", () => {
    const listings = [
      testListingWithCount({ active: true, id: 1, slug: "ab12c" }),
      testListingWithCount({ active: true, id: 2, slug: "cd34e" }),
    ];
    const html = adminDashboardPage(listings, OWNER_SESSION);
    assert(!html.includes("Multi-booking link"));
    assert(!html.includes("data-multi-booking-slug"));
  });

  test("includes logout link", async () => {
    await withRequestContext(() => {
      const html = adminDashboardPage([], OWNER_SESSION);
      says(html, "/admin/logout");
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
    says(html, "<details open");
    says(html, "Newest 2 Attendees");
  });

  test("newest attendees section not shown when no attendees", () => {
    const html = adminDashboardPage([], OWNER_SESSION, undefined, []);
    assert(!html.includes("Newest"));
    assert(!html.includes("<details open"));
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

    says(html, "Upcoming holidays</summary>");
    says(html, 'class="table-scroll dashboard-holidays-scroll"');
    says(html, 'href="/admin/holidays/1"');
    says(html, "Winter Break");
    says(html, "2026-12-24");
    says(html, "2026-12-26");
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
    says(html, "Upcoming service events</summary>");
    says(html, 'href="/admin/servicing/42"');
    says(html, "Boiler Service");
    says(html, "2099");
    says(html, "1 listing · 2");
    says(html, 'href="/admin/servicing/43"');
    says(html, "Unassigned Service");
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
    says(html, "Newest 1 Attendee</summary>");
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
    says(html, "<th>Listings</th>");
    says(html, "Workshop");
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
    says(html, "Newest 1 Attendee</summary>");
    says(
      html,
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
    assert(!html.includes("Newest"));
    assert(!html.includes("<details open"));
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
    says(html, "Valid");
    assert(!html.includes("Orphan"));
    says(html, "Newest 1 Attendee</summary>");
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
    assert(!html.includes("inactive-row"));
    assert(!html.includes('href="/admin/listing/1"'));
    says(html, "No listings yet");
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
    says(html, "April 2026");
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
    says(html, "Friday 10 April 2026");
  });
});

describe("activeListingStatsSection", () => {
  test("renders income, tickets, and attendees", () => {
    const html = activeListingStatsSection({
      attendees: 52,
      income: 5000,
      tickets: 30,
    });
    says(html, "Active Listing Statistics");
    says(html, "<strong>Income:</strong>");
    says(html, "<strong>Tickets:</strong>");
    says(html, "<strong>Attendees:</strong>");
    says(html, "30");
    says(html, "52");
  });

  test("renders zero values", () => {
    const html = activeListingStatsSection({
      attendees: 0,
      income: 0,
      tickets: 0,
    });
    says(html, "<strong>Tickets:</strong> 0");
    says(html, "<strong>Attendees:</strong> 0");
  });

  test("renders as closed details element", () => {
    const html = activeListingStatsSection({
      attendees: 0,
      income: 0,
      tickets: 0,
    });
    says(html, "<details>");
    assert(!html.includes("<details open"));
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
    says(html, "Active Listing Statistics");
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
    assert(!html.includes("Active Listing Statistics"));
  });

  test("does not show stats section when stats not provided", () => {
    const html = adminDashboardPage([], OWNER_SESSION);
    assert(!html.includes("Active Listing Statistics"));
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
    says(html, "Showing:");
    says(html, 'href="/admin/?type=standard"');
    says(html, 'href="/admin/?type=daily"');
  });

  test("hides the filter bar when only one type is present", () => {
    const onlyStandard = testListingWithCount({
      id: 3,
      listing_type: "standard",
      slug: "std02",
    });
    const html = adminDashboardPage([standard, onlyStandard], OWNER_SESSION);
    assert(!html.includes("Showing:"));
  });

  test("shows every type and marks 'All' active on the default view", () => {
    const html = adminDashboardPage([standard, daily], OWNER_SESSION);
    says(html, "Standard Listing");
    says(html, "Daily Listing");
    says(html, "<strong><u>All</u></strong>");
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
    says(html, "Daily Listing");
    assert(!html.includes("Standard Listing"));
    says(html, "<strong><u>Daily</u></strong>");
    // The "All" option links back to the unfiltered dashboard.
    says(html, '<a href="/admin/">All</a>');
  });

  test("does not show a CSV export footer (the dashboard table is active-only)", () => {
    const html = adminDashboardPage([standard, daily], OWNER_SESSION);
    assert(!html.includes("/admin/listings/csv"));
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
        says(html, "/image/thumb.jpg");
        says(html, 'class="listing-thumbnail"');
      });

      test("does not show thumbnail when listing has no image_url", () => {
        const listings = [testListingWithCount({ image_url: "" })];
        const html = adminDashboardPage(listings, OWNER_SESSION);
        assert(!html.includes('src="/image/'));
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
    says(html, 'class="active" href="/admin/listings"');
    says(html, "Active Show");
    says(html, "Deactivated");
    says(html, "Old Show");
    expect(html.indexOf("Active Show")).toBeLessThan(html.indexOf("Old Show"));
    // The Listings section sub-nav offers the catalog import entry point.
    says(html, 'href="/admin/catalog/import"');
  });

  test("omits the deactivated heading when every listing is active", () => {
    const html = adminListingsPage(
      [testListingWithCount({ active: true, name: "Active Show" })],
      OWNER_SESSION,
    );
    assert(!html.includes("Deactivated"));
  });

  test("links to the listings CSV export", () => {
    const html = adminListingsPage(
      [testListingWithCount({ name: "Active Show" })],
      OWNER_SESSION,
    );
    says(html, 'class="table-actions"');
    says(html, 'href="/admin/listings/csv"');
    says(html, "Export CSV");
  });
});
