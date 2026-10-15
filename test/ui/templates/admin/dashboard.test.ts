import { assert, assertStringIncludes } from "@std/assert";
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
    assertStringIncludes(html, "Listings");
    assertStringIncludes(html, "No listings yet");
  });

  test("renders listings table", () => {
    const listings = [testListingWithCount({ attendee_count: 25 })];
    const html = adminDashboardPage(listings, OWNER_SESSION);
    assertStringIncludes(html, "Test Listing");
    assertStringIncludes(html, "25 / 100");
    assertStringIncludes(html, "/admin/listing/1");
  });

  test("displays listing name", () => {
    const listings = [testListingWithCount({ name: "My Test Listing" })];
    const html = adminDashboardPage(listings, OWNER_SESSION);
    assertStringIncludes(html, "My Test Listing");
    assertStringIncludes(html, "Listing name");
  });

  test("renders the add-listing and add-attendee quick actions", () => {
    const html = adminDashboardPage([], OWNER_SESSION);
    assertStringIncludes(html, 'href="/admin/listing/new"');
    assertStringIncludes(html, "Add Listing");
    assertStringIncludes(html, 'href="/admin/attendees/new"');
    assertStringIncludes(html, "Add Attendee");
  });

  test("does not render the multi-booking link builder", () => {
    const listings = [
      testListingWithCount({ active: true, id: 1, slug: "ab12c" }),
      testListingWithCount({ active: true, id: 2, slug: "cd34e" }),
    ];
    const html = adminDashboardPage(listings, OWNER_SESSION);
    assert(
      !html.includes("Multi-booking link"),
      "the value should not contain the searched item",
    );
    assert(
      !html.includes("data-multi-booking-slug"),
      "the value should not contain the searched item",
    );
  });

  test("includes logout link", async () => {
    await withRequestContext(() => {
      const html = adminDashboardPage([], OWNER_SESSION);
      assertStringIncludes(html, "/admin/logout");
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
    assertStringIncludes(html, "<details open");
    assertStringIncludes(html, "Newest 2 Attendees");
  });

  test("newest attendees section not shown when no attendees", () => {
    const html = adminDashboardPage([], OWNER_SESSION, undefined, []);
    assert(
      !html.includes("Newest"),
      "the value should not contain the searched item",
    );
    assert(
      !html.includes("<details open"),
      "the value should not contain the searched item",
    );
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

    assertStringIncludes(html, "Upcoming holidays</summary>");
    assertStringIncludes(
      html,
      'class="table-scroll dashboard-holidays-scroll"',
    );
    assertStringIncludes(html, 'href="/admin/holidays/1"');
    assertStringIncludes(html, "Winter Break");
    assertStringIncludes(html, "2026-12-24");
    assertStringIncludes(html, "2026-12-26");
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
    assertStringIncludes(html, "Upcoming service events</summary>");
    assertStringIncludes(html, 'href="/admin/servicing/42"');
    assertStringIncludes(html, "Boiler Service");
    assertStringIncludes(html, "2099");
    assertStringIncludes(html, "1 listing · 2");
    assertStringIncludes(html, 'href="/admin/servicing/43"');
    assertStringIncludes(html, "Unassigned Service");
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
    assertStringIncludes(html, "Newest 1 Attendee</summary>");
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
    assertStringIncludes(html, "<th>Listings</th>");
    assertStringIncludes(html, "Workshop");
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
    assertStringIncludes(html, "Newest 1 Attendee</summary>");
    assertStringIncludes(
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
    assert(
      !html.includes("Newest"),
      "the value should not contain the searched item",
    );
    assert(
      !html.includes("<details open"),
      "the value should not contain the searched item",
    );
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
    assertStringIncludes(html, "Valid");
    assert(
      !html.includes("Orphan"),
      "the value should not contain the searched item",
    );
    assertStringIncludes(html, "Newest 1 Attendee</summary>");
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
    assert(
      !html.includes("inactive-row"),
      "the value should not contain the searched item",
    );
    assert(
      !html.includes('href="/admin/listing/1"'),
      "the value should not contain the searched item",
    );
    assertStringIncludes(html, "No listings yet");
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
    assertStringIncludes(html, "April 2026");
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
    assertStringIncludes(html, "Friday 10 April 2026");
  });
});

describe("activeListingStatsSection", () => {
  test("renders income, tickets, and attendees", () => {
    const html = activeListingStatsSection({
      attendees: 52,
      income: 5000,
      tickets: 30,
    });
    assertStringIncludes(html, "Active Listing Statistics");
    assertStringIncludes(html, "<strong>Income:</strong>");
    assertStringIncludes(html, "<strong>Tickets:</strong>");
    assertStringIncludes(html, "<strong>Attendees:</strong>");
    assertStringIncludes(html, "30");
    assertStringIncludes(html, "52");
  });

  test("renders zero values", () => {
    const html = activeListingStatsSection({
      attendees: 0,
      income: 0,
      tickets: 0,
    });
    assertStringIncludes(html, "<strong>Tickets:</strong> 0");
    assertStringIncludes(html, "<strong>Attendees:</strong> 0");
  });

  test("renders as closed details element", () => {
    const html = activeListingStatsSection({
      attendees: 0,
      income: 0,
      tickets: 0,
    });
    assertStringIncludes(html, "<details>");
    assert(
      !html.includes("<details open"),
      "the value should not contain the searched item",
    );
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
    assertStringIncludes(html, "Active Listing Statistics");
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
    assert(
      !html.includes("Active Listing Statistics"),
      "the value should not contain the searched item",
    );
  });

  test("does not show stats section when stats not provided", () => {
    const html = adminDashboardPage([], OWNER_SESSION);
    assert(
      !html.includes("Active Listing Statistics"),
      "the value should not contain the searched item",
    );
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
    assertStringIncludes(html, "Showing:");
    assertStringIncludes(html, 'href="/admin/?type=standard"');
    assertStringIncludes(html, 'href="/admin/?type=daily"');
  });

  test("hides the filter bar when only one type is present", () => {
    const onlyStandard = testListingWithCount({
      id: 3,
      listing_type: "standard",
      slug: "std02",
    });
    const html = adminDashboardPage([standard, onlyStandard], OWNER_SESSION);
    assert(
      !html.includes("Showing:"),
      "the value should not contain the searched item",
    );
  });

  test("shows every type and marks 'All' active on the default view", () => {
    const html = adminDashboardPage([standard, daily], OWNER_SESSION);
    assertStringIncludes(html, "Standard Listing");
    assertStringIncludes(html, "Daily Listing");
    assertStringIncludes(html, "<strong><u>All</u></strong>");
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
    assertStringIncludes(html, "Daily Listing");
    assert(
      !html.includes("Standard Listing"),
      "the value should not contain the searched item",
    );
    assertStringIncludes(html, "<strong><u>Daily</u></strong>");
    // The "All" option links back to the unfiltered dashboard.
    assertStringIncludes(html, '<a href="/admin/">All</a>');
  });

  test("does not show a CSV export footer (the dashboard table is active-only)", () => {
    const html = adminDashboardPage([standard, daily], OWNER_SESSION);
    assert(
      !html.includes("/admin/listings/csv"),
      "the value should not contain the searched item",
    );
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
        assertStringIncludes(html, "/image/thumb.jpg");
        assertStringIncludes(html, 'class="listing-thumbnail"');
      });

      test("does not show thumbnail when listing has no image_url", () => {
        const listings = [testListingWithCount({ image_url: "" })];
        const html = adminDashboardPage(listings, OWNER_SESSION);
        assert(
          !html.includes('src="/image/'),
          "the value should not contain the searched item",
        );
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
    assertStringIncludes(html, 'class="active" href="/admin/listings"');
    assertStringIncludes(html, "Active Show");
    assertStringIncludes(html, "Deactivated");
    assertStringIncludes(html, "Old Show");
    expect(html.indexOf("Active Show")).toBeLessThan(html.indexOf("Old Show"));
    // The Listings section sub-nav offers the catalog import entry point.
    assertStringIncludes(html, 'href="/admin/catalog/import"');
  });

  test("omits the deactivated heading when every listing is active", () => {
    const html = adminListingsPage(
      [testListingWithCount({ active: true, name: "Active Show" })],
      OWNER_SESSION,
    );
    assert(
      !html.includes("Deactivated"),
      "the value should not contain the searched item",
    );
  });

  test("links to the listings CSV export", () => {
    const html = adminListingsPage(
      [testListingWithCount({ name: "Active Show" })],
      OWNER_SESSION,
    );
    assertStringIncludes(html, 'class="table-actions"');
    assertStringIncludes(html, 'href="/admin/listings/csv"');
    assertStringIncludes(html, "Export CSV");
  });
});
