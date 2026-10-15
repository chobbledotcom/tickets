import { assert, assertStringIncludes } from "@std/assert";
import { describe, it as test } from "@std/testing/bdd";
import {
  registerListingTemplateHooks,
  renderListingDetail,
} from "#test/ui/templates/admin/listings/helpers.ts";
import { withEnv } from "#test-utils/env.ts";
import {
  testAttendee,
  testGroup,
  testListingWithCount,
} from "#test-utils/factories.ts";

/** One checked-in (qty 2) and one not-checked-in (qty 3) attendee — the mix the
 *  dual checked-in row tests share. */
const multiQtyPair = () => [
  testAttendee({ checked_in: 2, id: 1, quantity: 2 }),
  testAttendee({ checked_in: 0, id: 2, quantity: 3 }),
];
const dailyListingFive = () =>
  testListingWithCount({ attendee_count: 5, listing_type: "daily" });

describe("adminListingPage duration display", () => {
  registerListingTemplateHooks();

  test("shows booking duration row for daily listings", () => {
    const listing = testListingWithCount({
      attendee_count: 0,
      duration_days: 3,
      listing_type: "daily",
    });
    const html = renderListingDetail({
      allowedDomain: "localhost",
      attendees: [],
      listing,
    });
    assertStringIncludes(html, "Booking duration");
    assertStringIncludes(html, "3 day(s)");
  });

  test("omits booking duration row for standard listings", () => {
    const listing = testListingWithCount({
      attendee_count: 0,
      duration_days: 1,
      listing_type: "standard",
    });
    const html = renderListingDetail({
      allowedDomain: "localhost",
      attendees: [],
      listing,
    });
    assert(
      !html.toLowerCase().includes("booking duration"),
      "the value should not contain the searched item",
    );
  });

  test("shows the customisable-days prices on a customisable listing", () => {
    const listing = testListingWithCount({
      attendee_count: 0,
      customisable_days: true,
      day_prices: { 1: 1000, 2: 1800 },
      duration_days: 2,
    });
    const html = renderListingDetail({
      allowedDomain: "localhost",
      attendees: [],
      listing,
    });
    assertStringIncludes(html, "Customisable days");
    assertStringIncludes(html, "1 day:");
    assertStringIncludes(html, "2 days:");
  });

  test("offers a day-count selector when adding to a customisable daily listing", () => {
    const listing = testListingWithCount({
      attendee_count: 0,
      customisable_days: true,
      day_prices: { 1: 1000, 2: 1800 },
      duration_days: 2,
      listing_type: "daily",
    });
    const html = renderListingDetail({
      allowedDomain: "localhost",
      attendees: [],
      listing,
    });
    assertStringIncludes(html, 'name="day_count"');
    assertStringIncludes(html, "Number of days");
  });

  test("notes when a customisable listing has no day prices set", () => {
    const listing = testListingWithCount({
      attendee_count: 0,
      customisable_days: true,
      day_prices: {},
      duration_days: 3,
    });
    const html = renderListingDetail({
      allowedDomain: "localhost",
      attendees: [],
      listing,
    });
    assertStringIncludes(html, "No day prices set");
  });

  test("omits the customisable-days row for a fixed-duration listing", () => {
    const listing = testListingWithCount({
      attendee_count: 0,
      customisable_days: false,
    });
    const html = renderListingDetail({
      allowedDomain: "localhost",
      attendees: [],
      listing,
    });
    assert(
      !html.toLowerCase().includes("customisable days"),
      "the value should not contain the searched item",
    );
  });
});

describe("adminListingPage details table", () => {
  registerListingTemplateHooks();

  const listing = testListingWithCount({ attendee_count: 2 });
  const renderMismatch = (): string =>
    renderListingDetail({
      aggregateRecalculation: {
        booked_quantity: { current: 2, recalculated: 1 },
        tickets_count: { current: 0, recalculated: 0 },
      },
      allowedDomain: "localhost",
      attendees: [],
      listing,
    });

  test("renders listing name", () => {
    const html = renderListingDetail({
      allowedDomain: "localhost",
      attendees: [],
      listing,
    });
    assertStringIncludes(html, "Test Listing");
  });

  test("shows the listing ticket price in the details table", () => {
    const paidListing = testListingWithCount({ unit_price: 1250 });
    const html = renderListingDetail({
      allowedDomain: "localhost",
      attendees: [],
      listing: paidListing,
    });
    assertStringIncludes(html, "Ticket Price");
    assertStringIncludes(html, "£12.50");
  });

  test("shows pay-more price bounds in the details table", () => {
    const payMoreListing = testListingWithCount({
      can_pay_more: true,
      max_price: 2500,
      unit_price: 1000,
    });
    const html = renderListingDetail({
      allowedDomain: "localhost",
      attendees: [],
      listing: payMoreListing,
    });
    assertStringIncludes(html, "Ticket Price");
    assertStringIncludes(html, "£10");
    assertStringIncludes(html, "pay more: £10–£25");
  });

  test("shows pay-more enabled when no higher maximum is configured", () => {
    const payMoreListing = testListingWithCount({
      can_pay_more: true,
      max_price: 0,
      unit_price: 0,
    });
    const html = renderListingDetail({
      allowedDomain: "localhost",
      attendees: [],
      listing: payMoreListing,
    });
    assertStringIncludes(html, "Ticket Price");
    assertStringIncludes(html, "Free");
    assertStringIncludes(html, "pay more enabled");
  });

  test("shows free when the listing has no ticket price", () => {
    const freeListing = testListingWithCount({ unit_price: 0 });
    const html = renderListingDetail({
      allowedDomain: "localhost",
      attendees: [],
      listing: freeListing,
    });
    assertStringIncludes(html, "Ticket Price");
    assertStringIncludes(html, "Free");
  });

  test("shows attendees row with count and remaining", () => {
    const html = renderListingDetail({
      allowedDomain: "localhost",
      attendees: [],
      listing,
    });
    assertStringIncludes(html, "Listing Attendees");
    assertStringIncludes(html, "2 / 100");
    assertStringIncludes(html, "98 remain");
  });

  test("shows a running-total mismatch in the details table", () => {
    const html = renderMismatch();
    assertStringIncludes(html, "Running total check");
    assertStringIncludes(html, "expected <strong>1</strong>, got");
    assertStringIncludes(html, "Mismatch");
    assert(
      !html.includes("Click for info"),
      "the value should not contain the searched item",
    );
    assertStringIncludes(html, `/admin/listings/recalculate/${listing.id}`);
  });

  test("shows a running-total mismatch without its repair link in read-only mode", () => {
    using _env = withEnv({ READ_ONLY_FROM: "2020-01-01T00:00:00.000Z" });
    const html = renderMismatch();
    assertStringIncludes(html, "Running total check");
    assert(
      !html.includes(`/admin/listings/recalculate/${listing.id}`),
      "the value should not contain the searched item",
    );
  });

  test("renders no Group Attendees row when groupContext is omitted", () => {
    const html = renderListingDetail({
      allowedDomain: "localhost",
      attendees: [],
      listing,
    });
    assert(
      !html.includes("Group Attendees"),
      "the value should not contain the searched item",
    );
  });

  test("shows Group Attendees row with count, cap, remaining, and link", () => {
    const group = testGroup({
      id: 7,
      max_attendees: 50,
      name: "Summer Festival",
    });
    const html = renderListingDetail({
      allowedDomain: "localhost",
      attendees: [],
      groupContext: { attendeeCount: 30, group },
      listing,
    });
    assertStringIncludes(html, "Group Attendees");
    assertStringIncludes(html, "30 / 50");
    assertStringIncludes(html, "20 remain");
    assertStringIncludes(html, 'href="/admin/groups/7"');
    assertStringIncludes(html, "Summer Festival");
    assertStringIncludes(html, "across all listings");
  });

  test("Group Attendees row gets danger-text when at or near cap", () => {
    const group = testGroup({ id: 8, max_attendees: 10 });
    const html = renderListingDetail({
      allowedDomain: "localhost",
      attendees: [],
      groupContext: { attendeeCount: 10, group },
      listing,
    });
    assertStringIncludes(html, "danger-text");
    assertStringIncludes(html, "10 / 10");
    assertStringIncludes(html, "0 remain");
  });

  test("shows checked in row with 0 of 0 when no attendees", () => {
    const html = renderListingDetail({
      allowedDomain: "localhost",
      attendees: [],
      listing,
    });
    assertStringIncludes(html, "Checked In");
    assertStringIncludes(html, "0 / 0");
    assertStringIncludes(html, "0 remain");
  });

  test("shows checked in count and remaining", () => {
    const attendees = [
      testAttendee({ checked_in: 1, id: 1 }),
      testAttendee({ checked_in: 0, id: 2 }),
      testAttendee({ checked_in: 0, id: 3 }),
    ];
    const html = renderListingDetail({
      allowedDomain: "localhost",
      attendees,
      listing,
    });
    assertStringIncludes(html, "Checked In");
    assertStringIncludes(html, "1 / 3");
    assertStringIncludes(html, "2 remain");
  });

  test("roster keeps one row per booking line, with no Listings column", () => {
    const attendees = [testAttendee({ id: 8, listing_id: listing.id })];
    const html = renderListingDetail({
      allowedDomain: "localhost",
      attendees,
      listing,
    });
    // The roster is scoped to one listing, so the Listings column stays off
    // and each line keeps its own per-listing check-in action.
    assert(
      !html.includes("<th>Listings</th>"),
      "the value should not contain the searched item",
    );
    assertStringIncludes(
      html,
      `/admin/listing/${listing.id}/attendee/8/checkin`,
    );
  });

  test("shows dual checked-in rows when attendees have multi-quantity", () => {
    const html = renderListingDetail({
      allowedDomain: "localhost",
      attendees: multiQtyPair(),
      listing,
    });
    // Tickets Checked In: 1 row / 2 rows, 1 remain
    assertStringIncludes(html, "Tickets Checked In");
    assertStringIncludes(html, "1 / 2");
    assertStringIncludes(html, "1 remain");
    // Attendees Checked In: 2 qty / 5 total qty, 3 remain
    assertStringIncludes(html, "Attendees Checked In");
    assertStringIncludes(html, "2 / 5");
    assertStringIncludes(html, "3 remain");
  });

  test("dual checked-in rows show daily suffix when daily listing with dateFilter", () => {
    const html = renderListingDetail({
      allowedDomain: "localhost",
      attendees: multiQtyPair(),
      dateFilter: "2026-03-15",
      listing: dailyListingFive(),
    });
    assertStringIncludes(html, "Attendees Checked In (Sunday 15 March 2026)");
    assertStringIncludes(html, "Tickets Checked In (Sunday 15 March 2026)");
  });

  test("dual checked-in rows show total suffix when daily listing without dateFilter", () => {
    const html = renderListingDetail({
      allowedDomain: "localhost",
      attendees: multiQtyPair(),
      listing: dailyListingFive(),
    });
    assertStringIncludes(html, "Attendees Checked In (total)");
    assertStringIncludes(html, "Tickets Checked In (total)");
  });
});
