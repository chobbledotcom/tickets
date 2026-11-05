import { assert, assertStringIncludes } from "@std/assert";
import { describe, it as test } from "@std/testing/bdd";
import {
  registerListingTemplateHooks,
  renderListingDetail,
} from "#test/ui/templates/admin/listings/helpers.ts";
import { expectIncludesAll } from "#test-utils/assertions.ts";
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
    expectIncludesAll(html, ["Booking duration", "3 day(s)"]);
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
    assert(!html.toLowerCase().includes("booking duration"));
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
    expectIncludesAll(html, ["Customisable days", "1 day:", "2 days:"]);
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
    expectIncludesAll(html, ['name="day_count"', "Number of days"]);
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
    assert(!html.toLowerCase().includes("customisable days"));
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
    expectIncludesAll(html, ["Ticket Price", "£12.50"]);
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
    expectIncludesAll(html, ["Ticket Price", "£10", "pay more: £10–£25"]);
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
    expectIncludesAll(html, ["Ticket Price", "Free", "pay more enabled"]);
  });

  test("shows free when the listing has no ticket price", () => {
    const freeListing = testListingWithCount({ unit_price: 0 });
    const html = renderListingDetail({
      allowedDomain: "localhost",
      attendees: [],
      listing: freeListing,
    });
    expectIncludesAll(html, ["Ticket Price", "Free"]);
  });

  test("shows attendees row with count and remaining", () => {
    const html = renderListingDetail({
      allowedDomain: "localhost",
      attendees: [],
      listing,
    });
    expectIncludesAll(html, ["Listing Attendees", "2 / 100", "98 remain"]);
  });

  test("shows a running-total mismatch in the details table", () => {
    const html = renderMismatch();
    expectIncludesAll(html, [
      "Running total check",
      "expected <strong>1</strong>, got",
      "Mismatch",
    ]);
    assert(!html.includes("Click for info"));
    assertStringIncludes(html, `/admin/listings/recalculate/${listing.id}`);
  });

  test("shows a running-total mismatch without its repair link in read-only mode", () => {
    using _env = withEnv({ READ_ONLY_FROM: "2020-01-01T00:00:00.000Z" });
    const html = renderMismatch();
    assertStringIncludes(html, "Running total check");
    assert(!html.includes(`/admin/listings/recalculate/${listing.id}`));
  });

  test("renders no Group Attendees row when groupContext is omitted", () => {
    const html = renderListingDetail({
      allowedDomain: "localhost",
      attendees: [],
      listing,
    });
    assert(!html.includes("Group Attendees"));
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
    expectIncludesAll(html, [
      "Group Attendees",
      "30 / 50",
      "20 remain",
      'href="/admin/groups/7"',
      "Summer Festival",
      "across all listings",
    ]);
  });

  test("Group Attendees row gets danger-text when at or near cap", () => {
    const group = testGroup({ id: 8, max_attendees: 10 });
    const html = renderListingDetail({
      allowedDomain: "localhost",
      attendees: [],
      groupContext: { attendeeCount: 10, group },
      listing,
    });
    expectIncludesAll(html, ["danger-text", "10 / 10", "0 remain"]);
  });

  test("shows checked in row with 0 of 0 when no attendees", () => {
    const html = renderListingDetail({
      allowedDomain: "localhost",
      attendees: [],
      listing,
    });
    expectIncludesAll(html, ["Checked In", "0 / 0", "0 remain"]);
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
    expectIncludesAll(html, ["Checked In", "1 / 3", "2 remain"]);
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
    assert(!html.includes("<th>Listings</th>"));
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
    expectIncludesAll(html, [
      "Tickets Checked In",
      "1 / 2",
      "1 remain",
      // Attendees Checked In: 2 qty / 5 total qty, 3 remain
      "Attendees Checked In",
      "2 / 5",
      "3 remain",
    ]);
  });

  test("dual checked-in rows show daily suffix when daily listing with dateFilter", () => {
    const html = renderListingDetail({
      allowedDomain: "localhost",
      attendees: multiQtyPair(),
      dateFilter: "2026-03-15",
      listing: dailyListingFive(),
    });
    expectIncludesAll(html, [
      "Attendees Checked In (Sunday 15 March 2026)",
      "Tickets Checked In (Sunday 15 March 2026)",
    ]);
  });

  test("dual checked-in rows show total suffix when daily listing without dateFilter", () => {
    const html = renderListingDetail({
      allowedDomain: "localhost",
      attendees: multiQtyPair(),
      listing: dailyListingFive(),
    });
    expectIncludesAll(html, [
      "Attendees Checked In (total)",
      "Tickets Checked In (total)",
    ]);
  });
});
