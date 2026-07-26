import { expect } from "@std/expect";
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
  testAttendee({ checked_in: true, id: 1, quantity: 2 }),
  testAttendee({ checked_in: false, id: 2, quantity: 3 }),
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
    expect(html).toContain("Booking Duration");
    expect(html).toContain("3 day(s)");
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
    expect(html).not.toContain("Booking Duration");
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
    expect(html).toContain("Customisable Days");
    expect(html).toContain("1 day:");
    expect(html).toContain("2 days:");
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
    expect(html).toContain('name="day_count"');
    expect(html).toContain("Number of days");
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
    expect(html).toContain("No day prices set");
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
    expect(html).not.toContain("Customisable Days");
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
    expect(html).toContain("Test Listing");
  });

  test("shows the listing ticket price in the details table", () => {
    const paidListing = testListingWithCount({ unit_price: 1250 });
    const html = renderListingDetail({
      allowedDomain: "localhost",
      attendees: [],
      listing: paidListing,
    });
    expect(html).toContain("Ticket Price");
    expect(html).toContain("£12.50");
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
    expect(html).toContain("Ticket Price");
    expect(html).toContain("£10");
    expect(html).toContain("pay more: £10–£25");
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
    expect(html).toContain("Ticket Price");
    expect(html).toContain("Free");
    expect(html).toContain("pay more enabled");
  });

  test("shows free when the listing has no ticket price", () => {
    const freeListing = testListingWithCount({ unit_price: 0 });
    const html = renderListingDetail({
      allowedDomain: "localhost",
      attendees: [],
      listing: freeListing,
    });
    expect(html).toContain("Ticket Price");
    expect(html).toContain("Free");
  });

  test("shows attendees row with count and remaining", () => {
    const html = renderListingDetail({
      allowedDomain: "localhost",
      attendees: [],
      listing,
    });
    expect(html).toContain("Listing Attendees");
    expect(html).toContain("2 / 100");
    expect(html).toContain("98 remain");
  });

  test("shows a running-total mismatch in the details table", () => {
    const html = renderMismatch();
    expect(html).toContain("Running total check");
    expect(html).toContain("expected <strong>1</strong>, got");
    expect(html).toContain("Mismatch");
    expect(html).not.toContain("Click for info");
    expect(html).toContain(`/admin/listings/recalculate/${listing.id}`);
  });

  test("shows a running-total mismatch without its repair link in read-only mode", () => {
    using _env = withEnv({ READ_ONLY_FROM: "2020-01-01T00:00:00.000Z" });
    const html = renderMismatch();
    expect(html).toContain("Running total check");
    expect(html).not.toContain(`/admin/listings/recalculate/${listing.id}`);
  });

  test("renders no Group Attendees row when groupContext is omitted", () => {
    const html = renderListingDetail({
      allowedDomain: "localhost",
      attendees: [],
      listing,
    });
    expect(html).not.toContain("Group Attendees");
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
    expect(html).toContain("Group Attendees");
    expect(html).toContain("30 / 50");
    expect(html).toContain("20 remain");
    expect(html).toContain('href="/admin/groups/7"');
    expect(html).toContain("Summer Festival");
    expect(html).toContain("across all listings");
  });

  test("Group Attendees row gets danger-text when at or near cap", () => {
    const group = testGroup({ id: 8, max_attendees: 10 });
    const html = renderListingDetail({
      allowedDomain: "localhost",
      attendees: [],
      groupContext: { attendeeCount: 10, group },
      listing,
    });
    expect(html).toContain("danger-text");
    expect(html).toContain("10 / 10");
    expect(html).toContain("0 remain");
  });

  test("shows checked in row with 0 of 0 when no attendees", () => {
    const html = renderListingDetail({
      allowedDomain: "localhost",
      attendees: [],
      listing,
    });
    expect(html).toContain("Checked In");
    expect(html).toContain("0 / 0");
    expect(html).toContain("0 remain");
  });

  test("shows checked in count and remaining", () => {
    const attendees = [
      testAttendee({ checked_in: true, id: 1 }),
      testAttendee({ checked_in: false, id: 2 }),
      testAttendee({ checked_in: false, id: 3 }),
    ];
    const html = renderListingDetail({
      allowedDomain: "localhost",
      attendees,
      listing,
    });
    expect(html).toContain("Checked In");
    expect(html).toContain("1 / 3");
    expect(html).toContain("2 remain");
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
    expect(html).not.toContain("<th>Listings</th>");
    expect(html).toContain(`/admin/listing/${listing.id}/attendee/8/checkin`);
  });

  test("shows dual checked-in rows when attendees have multi-quantity", () => {
    const html = renderListingDetail({
      allowedDomain: "localhost",
      attendees: multiQtyPair(),
      listing,
    });
    // Tickets Checked In: 1 row / 2 rows, 1 remain
    expect(html).toContain("Tickets Checked In");
    expect(html).toContain("1 / 2");
    expect(html).toContain("1 remain");
    // Attendees Checked In: 2 qty / 5 total qty, 3 remain
    expect(html).toContain("Attendees Checked In");
    expect(html).toContain("2 / 5");
    expect(html).toContain("3 remain");
  });

  test("dual checked-in rows show daily suffix when daily listing with dateFilter", () => {
    const html = renderListingDetail({
      allowedDomain: "localhost",
      attendees: multiQtyPair(),
      dateFilter: "2026-03-15",
      listing: dailyListingFive(),
    });
    expect(html).toContain("Attendees Checked In (Sunday 15 March 2026)");
    expect(html).toContain("Tickets Checked In (Sunday 15 March 2026)");
  });

  test("dual checked-in rows show total suffix when daily listing without dateFilter", () => {
    const html = renderListingDetail({
      allowedDomain: "localhost",
      attendees: multiQtyPair(),
      listing: dailyListingFive(),
    });
    expect(html).toContain("Attendees Checked In (total)");
    expect(html).toContain("Tickets Checked In (total)");
  });
});
