import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import {
  NO_QUANTITY_PREFIX,
  QTY_PREFIX,
} from "#routes/admin/attendee-form-model.ts";
import { signCsrfToken } from "#shared/csrf.ts";
import { getDb } from "#shared/db/client.ts";
import {
  activeListingStatsSection,
  adminDashboardPage,
  adminListingsPage,
} from "#templates/admin/dashboard.tsx";
import {
  adminPost,
  createDailyTestListing,
  createServicingHold,
  createTestListing,
  createTestServicingEvent,
  describeWithEnv,
  renderAdminPage,
  setupTestEncryptionKey,
  testAttendee,
  testListingWithCount,
  updateServicingEvent,
} from "#test-utils";

const TEST_SESSION = { adminLevel: "owner" as const };

beforeAll(async () => {
  setupTestEncryptionKey();
  await signCsrfToken();
});

describe("adminDashboardPage", () => {
  test("renders empty state when no listings", () => {
    const html = adminDashboardPage([], TEST_SESSION);
    expect(html).toContain("Listings");
    expect(html).toContain("No listings yet");
  });

  test("renders listings table", () => {
    const listings = [testListingWithCount({ attendee_count: 25 })];
    const html = adminDashboardPage(listings, TEST_SESSION);
    expect(html).toContain("Test Listing");
    expect(html).toContain("25 / 100");
    expect(html).toContain("/admin/listing/1");
  });

  test("displays listing name", () => {
    const listings = [testListingWithCount({ name: "My Test Listing" })];
    const html = adminDashboardPage(listings, TEST_SESSION);
    expect(html).toContain("My Test Listing");
    expect(html).toContain("Listing Name");
  });

  test("renders add listing link", () => {
    const html = adminDashboardPage([], TEST_SESSION);
    expect(html).toContain('href="/admin/listing/new"');
    expect(html).toContain("Add Listing");
  });

  test("includes logout link", () => {
    const html = adminDashboardPage([], TEST_SESSION);
    expect(html).toContain("/admin/logout");
  });

  test("renders newest attendees in an open details element", () => {
    const listings = [testListingWithCount({ id: 1, name: "Gala Night" })];
    const attendees = [
      testAttendee({ id: 1, listing_id: 1, name: "Alice" }),
      testAttendee({ id: 2, listing_id: 1, name: "Bob" }),
    ];
    const html = adminDashboardPage(
      listings,
      TEST_SESSION,
      undefined,
      attendees,
    );
    expect(html).toContain("<details open");
    expect(html).toContain("Newest 2 Attendees");
  });

  test("newest attendees section not shown when no attendees", () => {
    const html = adminDashboardPage([], TEST_SESSION, undefined, []);
    expect(html).not.toContain("Newest");
    expect(html).not.toContain("<details open");
  });
  test("renders upcoming holidays in a constrained scrollable table", () => {
    const html = adminDashboardPage(
      [],
      TEST_SESSION,
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

    expect(html).toContain("Upcoming Holidays</summary>");
    expect(html).toContain('class="table-scroll dashboard-holidays-scroll"');
    expect(html).toContain('href="/admin/holidays/1/edit"');
    expect(html).toContain("Winter Break");
    expect(html).toContain("2026-12-24");
    expect(html).toContain("2026-12-26");
  });

  test("renders upcoming service events with listing details and edit links", () => {
    const listings = [testListingWithCount({ id: 7, name: "Room A" })];
    const html = adminDashboardPage(
      listings,
      TEST_SESSION,
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
      TEST_SESSION,
      undefined,
      attendees,
    );
    expect(html).toContain("Newest 1 Attendee</summary>");
  });

  test("newest attendees shows listing column", () => {
    const listings = [testListingWithCount({ id: 1, name: "Workshop" })];
    const attendees = [testAttendee({ id: 1, listing_id: 1 })];
    const html = adminDashboardPage(
      listings,
      TEST_SESSION,
      undefined,
      attendees,
    );
    expect(html).toContain("<th>Listing</th>");
    expect(html).toContain("Workshop");
  });

  test("newest attendees not shown when all attendees have unknown listing_id", () => {
    const listings = [testListingWithCount({ id: 1 })];
    const attendees = [testAttendee({ id: 1, listing_id: 999 })];
    const html = adminDashboardPage(
      listings,
      TEST_SESSION,
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
      TEST_SESSION,
      undefined,
      attendees,
    );
    expect(html).toContain("Valid");
    expect(html).not.toContain("Orphan");
    expect(html).toContain("Newest 1 Attendee</summary>");
  });
});

describe("adminDashboardPage inactive listings", () => {
  test("hides inactive listings from home", () => {
    const listings = [
      testListingWithCount({
        active: false,
        attendee_count: 5,
        name: "Inactive",
      }),
    ];
    const html = adminDashboardPage(listings, TEST_SESSION);
    expect(html).not.toContain("inactive-row");
    expect(html).not.toContain('href="/admin/listing/1"');
    expect(html).toContain("No listings yet");
  });
});

describe("adminDashboardPage with column template filters", () => {
  test("applies date filter to created column", () => {
    const listings = [
      testListingWithCount({ created: "2026-04-10T14:00:00Z" }),
    ];
    const html = adminDashboardPage(
      listings,
      TEST_SESSION,
      undefined,
      [],
      undefined,
      null,
      '{{name}}, {{created | date: "%B %Y"}}',
    );
    expect(html).toContain("April 2026");
  });

  test("renders default cell format when no filter applied", () => {
    const listings = [
      testListingWithCount({ created: "2026-04-10T14:00:00Z" }),
    ];
    const html = adminDashboardPage(
      listings,
      TEST_SESSION,
      undefined,
      [],
      undefined,
      null,
      "{{name}}, {{created}}",
    );
    // Default uses toLocaleDateString — locale format, not Liquid strftime
    expect(html).toContain("2026");
    expect(html).not.toContain("April 2026");
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
  test("shows stats section when stats provided", () => {
    const html = adminDashboardPage(
      [],
      TEST_SESSION,
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
      TEST_SESSION,
      undefined,
      [],
      undefined,
      null,
    );
    expect(html).not.toContain("Active Listing Statistics");
  });

  test("does not show stats section when stats not provided", () => {
    const html = adminDashboardPage([], TEST_SESSION);
    expect(html).not.toContain("Active Listing Statistics");
  });
});

describe("adminDashboardPage multi-booking link", () => {
  const renderDashboard = (
    listings: ReturnType<typeof testListingWithCount>[],
    ...expectations: string[]
  ): string => {
    const html = adminDashboardPage(listings, TEST_SESSION);
    for (const expected of expectations) expect(html).toContain(expected);
    return html;
  };

  const expectNoMultiBookingLink = (
    listings: ReturnType<typeof testListingWithCount>[],
  ) => {
    expect(renderDashboard(listings)).not.toContain("Multi-booking link");
  };

  const twoListings = [
    testListingWithCount({ id: 1, slug: "ab12c" }),
    testListingWithCount({ id: 2, slug: "cd34e" }),
  ];

  const twoListingsWithFields = [
    testListingWithCount({ fields: "email", id: 1, slug: "ab12c" }),
    testListingWithCount({ fields: "email,phone", id: 2, slug: "cd34e" }),
  ];

  test("does not show multi-booking section with zero listings", () => {
    expectNoMultiBookingLink([]);
  });

  test("does not show multi-booking section with one active listing", () => {
    expectNoMultiBookingLink([testListingWithCount({ id: 1, slug: "ab12c" })]);
  });

  test("shows multi-booking section with two active listings", () => {
    renderDashboard(
      [
        testListingWithCount({ id: 1, name: "Listing A", slug: "ab12c" }),
        testListingWithCount({ id: 2, name: "Listing B", slug: "cd34e" }),
      ],
      "Multi-booking link",
      "Listing A",
      "Listing B",
    );
  });

  test("does not count inactive listings toward threshold", () => {
    expectNoMultiBookingLink([
      testListingWithCount({ active: true, id: 1, slug: "ab12c" }),
      testListingWithCount({ active: false, id: 2, slug: "cd34e" }),
    ]);
  });

  test("excludes inactive listings from checkboxes", () => {
    const html = renderDashboard(
      [
        testListingWithCount({
          active: true,
          id: 1,
          name: "Active One",
          slug: "ab12c",
        }),
        testListingWithCount({
          active: false,
          id: 2,
          name: "Inactive",
          slug: "cd34e",
        }),
        testListingWithCount({
          active: true,
          id: 3,
          name: "Active Two",
          slug: "ef56g",
        }),
      ],
      "Active One",
      "Active Two",
    );
    expect(html).not.toContain('data-multi-booking-slug="cd34e"');
  });

  test("renders checkboxes with slug data attributes", () => {
    renderDashboard(
      twoListings,
      'data-multi-booking-slug="ab12c"',
      'data-multi-booking-slug="cd34e"',
    );
  });

  test("renders URL input with domain data attribute", () => {
    renderDashboard(
      twoListings,
      'data-domain="localhost"',
      "data-multi-booking-url",
      "readonly",
      'for="multi-booking-url"',
      'id="multi-booking-url"',
    );
  });

  test("is collapsed by default via details element", () => {
    renderDashboard(twoListings, "<details>", "<summary>");
  });

  test("renders embed code inputs", () => {
    renderDashboard(
      twoListingsWithFields,
      "data-multi-booking-embed-script",
      "data-multi-booking-embed-iframe",
      'for="multi-booking-embed-script"',
      'for="multi-booking-embed-iframe"',
      'id="multi-booking-embed-script"',
      'id="multi-booking-embed-iframe"',
    );
  });

  test("checkboxes include data-fields attribute for embed code generation", () => {
    renderDashboard(
      twoListingsWithFields,
      'data-fields="email"',
      'data-fields="email,phone"',
    );
  });
});

describe("adminDashboardPage type filter", () => {
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
    const html = adminDashboardPage([standard, daily], TEST_SESSION);
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
    const html = adminDashboardPage([standard, onlyStandard], TEST_SESSION);
    expect(html).not.toContain("Showing:");
  });

  test("shows every type and marks 'All' active on the default view", () => {
    const html = adminDashboardPage([standard, daily], TEST_SESSION);
    expect(html).toContain("Standard Listing");
    expect(html).toContain("Daily Listing");
    expect(html).toContain("<strong><u>All</u></strong>");
  });

  test("filters the listing table to the active type", () => {
    // Standard is inactive so the multi-booking builder (active listings only)
    // doesn't render and the only place its name could appear is the table.
    const standardInactive = testListingWithCount({
      active: false,
      id: 1,
      listing_type: "standard",
      name: "Standard Listing",
      slug: "std01",
    });
    const html = adminDashboardPage(
      [standardInactive, daily],
      TEST_SESSION,
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

  test("keeps the multi-booking builder based on every active listing", () => {
    // Filtering the table to one type must not drop the others from the
    // multi-booking builder, which reflects all active listings.
    const html = adminDashboardPage(
      [standard, daily],
      TEST_SESSION,
      undefined,
      [],
      undefined,
      null,
      undefined,
      "daily",
    );
    expect(html).toContain("Multi-booking link");
    expect(html).toContain('data-multi-booking-slug="std01"');
    expect(html).toContain('data-multi-booking-slug="day01"');
  });

  test("does not show a CSV export footer (the dashboard table is active-only)", () => {
    const html = adminDashboardPage([standard, daily], TEST_SESSION);
    expect(html).not.toContain("/admin/listings/csv");
  });
});

describeWithEnv("admin servicing routes", { db: true }, () => {
  test("the servicing list route renders service-event row details", async () => {
    const listing = await createDailyTestListing({
      maxAttendees: 5,
      name: "Route Room",
    });
    const event = await createTestServicingEvent({
      bookings: [{ date: "2099-07-01", listingId: listing.id, quantity: 2 }],
      name: "Route Service",
    });
    const deletedListing = await createTestListing({
      maxAttendees: 5,
      name: "Deleted Route Listing",
    });
    await createTestServicingEvent({
      bookings: [{ listingId: deletedListing.id, quantity: 1 }],
      name: "Undated Route Service",
    });
    await getDb().execute({
      args: [deletedListing.id],
      sql: "DELETE FROM listings WHERE id = ?",
    });

    const html = await renderAdminPage("/admin/servicing");

    expect(html).toContain('class="servicing-event"');
    expect(html).toContain(`/admin/servicing/${event.id}`);
    expect(html).toContain("Route Service");
    expect(html).toContain("Route Room");
    expect(html).toContain("<td>2</td>");
    expect(html).toContain("Undated Route Service");
    expect(html).not.toContain("Deleted Route Listing");
  });

  test("the servicing update route updates name and default booking quantity", async () => {
    const { id, listing } = await createServicingHold({
      name: "Before Route Update",
    });

    const response = await adminPost(`/admin/servicing/${id}`, {
      name: "After Route Update",
      [`${QTY_PREFIX}${listing.id}`]: "1",
    });

    expect(response.headers.get("location")).toContain(
      `/admin/servicing/${id}`,
    );
    const updated = await updateServicingEvent(id, {
      bookings: [{ listingId: listing.id }],
      name: "Default Quantity Update",
    });
    expect(updated.bookings[0]!.quantity).toBe(1);
  });

  test("the servicing update route records costs when amount is present", async () => {
    const { id, listing } = await createServicingHold({
      name: "Route Cost",
    });

    const response = await adminPost(`/admin/servicing/${id}`, {
      amount: "12.34",
      memo: "Route cost",
      target_listing_id: String(listing.id),
    });

    expect(response.headers.get("location")).toContain(
      `/admin/servicing/${id}`,
    );
  });

  test("servicing mutation routes return not found for missing events", async () => {
    const editResponse = await adminPost("/admin/servicing/999999", {
      name: "Missing",
      [`${QTY_PREFIX}1`]: "1",
    });
    expect(editResponse.status).toBe(404);

    const costResponse = await adminPost("/admin/servicing/999999/cost/1", {
      amount: "1.00",
    });
    expect(costResponse.status).toBe(404);
  });

  test("servicing create rejects retained zero-quantity and over-capacity holds", async () => {
    const listing = await createDailyTestListing({
      maxAttendees: 1,
      name: "Validation Room",
    });

    await expect(
      adminPost("/admin/servicing/new", {
        name: "No Quantity Service",
        [`${NO_QUANTITY_PREFIX}${listing.id}`]: "1",
        [`${QTY_PREFIX}${listing.id}`]: "9",
      }),
    ).rejects.toThrow("capacity slot");

    await expect(
      createTestServicingEvent({
        bookings: [{ date: "2099-07-01", listingId: listing.id, quantity: 0 }],
        name: "Zero Quantity Service",
      }),
    ).rejects.toThrow("capacity slot");

    await expect(
      createTestServicingEvent({
        bookings: [],
        name: "Empty Service",
      }),
    ).rejects.toThrow("capacity slot");

    const defaultQuantity = await createTestServicingEvent({
      bookings: [{ date: "2099-07-02", listingId: listing.id }],
      name: "Default Quantity Service",
    });
    expect(defaultQuantity.bookings[0]!.quantity).toBe(1);

    await expect(
      createTestServicingEvent({
        bookings: [{ date: "2099-07-01", listingId: listing.id, quantity: 2 }],
        name: "Over Capacity Service",
      }),
    ).rejects.toThrow();
  });
});

describeWithEnv(
  "listing images",
  { env: { STORAGE_ZONE_KEY: "testkey", STORAGE_ZONE_NAME: "testzone" } },
  () => {
    describe("adminDashboardPage with images", () => {
      test("shows thumbnail when listing has image_url", () => {
        const listings = [testListingWithCount({ image_url: "thumb.jpg" })];
        const html = adminDashboardPage(listings, TEST_SESSION);
        expect(html).toContain("/image/thumb.jpg");
        expect(html).toContain('class="listing-thumbnail"');
      });

      test("does not show thumbnail when listing has no image_url", () => {
        const listings = [testListingWithCount({ image_url: "" })];
        const html = adminDashboardPage(listings, TEST_SESSION);
        expect(html).not.toContain('src="/image/');
      });
    });
  },
);

describe("adminListingsPage", () => {
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
    const html = adminListingsPage([active, inactive], TEST_SESSION);
    expect(html).toContain('class="active" href="/admin/listings"');
    expect(html).toContain("Active Show");
    expect(html).toContain("Deactivated");
    expect(html).toContain("Old Show");
    expect(html.indexOf("Active Show")).toBeLessThan(html.indexOf("Old Show"));
  });

  test("omits the deactivated heading when every listing is active", () => {
    const html = adminListingsPage(
      [testListingWithCount({ active: true, name: "Active Show" })],
      TEST_SESSION,
    );
    expect(html).not.toContain("Deactivated");
  });

  test("links to the listings CSV export", () => {
    const html = adminListingsPage(
      [testListingWithCount({ name: "Active Show" })],
      TEST_SESSION,
    );
    expect(html).toContain('class="table-actions"');
    expect(html).toContain('href="/admin/listings/csv"');
    expect(html).toContain("Export CSV");
  });
});
