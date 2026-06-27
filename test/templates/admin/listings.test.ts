import { expect } from "@std/expect";
import { afterEach, beforeAll, describe, it as test } from "@std/testing/bdd";
import { signCsrfToken } from "#shared/csrf.ts";
import { detectIframeMode } from "#shared/iframe.ts";
import { account } from "#shared/ledger/account.ts";
import { runWithStorageConfig } from "#shared/storage.ts";
import { emptyLedgerNames } from "#templates/admin/ledger.tsx";
import {
  adminDuplicateListingPage,
  adminListingEditPage,
  adminListingNewPage,
  adminListingPage,
  adminListingRecalculatePage,
  completePaymentAttendees,
  isIncompletePayment,
  nearCapacity,
} from "#templates/admin/listings.tsx";
import { getListingFields } from "#templates/fields.ts";
import {
  describeWithEnv,
  hasSelectedOption,
  setupTestEncryptionKey,
  testAttendee,
  testGroup,
  testListingWithCount,
  withStorageDisabled,
} from "#test-utils";

const TEST_SESSION = { adminLevel: "owner" as const };

beforeAll(async () => {
  setupTestEncryptionKey();
  await signCsrfToken();
});

afterEach(() => {
  detectIframeMode("https://example.com/");
});

describe("adminListingEditPage group select", () => {
  test("preselects the listing group_id when groups exist", () => {
    const groups = [testGroup({ id: 2, name: "Group Two" })];
    const listing = testListingWithCount({ group_id: 2 });
    const html = adminListingEditPage(listing, groups, TEST_SESSION);
    expect(html).toContain('name="group_id"');
    expect(hasSelectedOption(html, "2")).toBe(true);
    expect(hasSelectedOption(html, "0")).toBe(false);
  });
});

describe("adminListingEditPage duration warning", () => {
  test("includes duration warning + confirmation gate with current duration", () => {
    const listing = testListingWithCount({
      duration_days: 3,
      listing_type: "daily",
    });
    const html = adminListingEditPage(listing, [], TEST_SESSION);
    expect(html).toContain(
      "Changing booking duration will update existing bookings",
    );
    expect(html).toContain('id="duration-warning"');
    expect(html).toContain('id="duration-warning-confirm"');
    // The current duration is exposed via a data attribute so the bundled
    // admin script can compare against the form's input.
    expect(html).toContain('data-duration-original="3"');
  });
});

describe("adminListingEditPage day prices", () => {
  test("renders priced day-count inputs and checks the customisable toggle", () => {
    const listing = testListingWithCount({
      customisable_days: true,
      day_prices: { 1: 1000, 2: 1800 },
      duration_days: 2,
    });
    const html = adminListingEditPage(listing, [], TEST_SESSION);
    // One input per day up to the maximum duration, pre-filled from day_prices.
    expect(html).toContain('name="day_price_1"');
    expect(html).toContain('value="10.00"');
    expect(html).toContain('name="day_price_2"');
    expect(html).toContain('value="18.00"');
    // The customisable-days checkbox is rendered checked for such a listing.
    expect(html).toContain('name="customisable_days"');
    expect(html).toContain("Day Prices (customisable days)");
  });

  test("renders a single blank day-price row on the new-listing form", () => {
    const html = adminListingNewPage([], TEST_SESSION);
    expect(html).toContain('name="day_price_1"');
    // The maximum defaults to 1 day for a new listing, so only one row shows.
    expect(html).not.toContain('name="day_price_2"');
  });
});

describe("adminListingEditPage form sections", () => {
  test("groups fields under section legends and an Advanced disclosure", () => {
    const listing = testListingWithCount();
    const html = adminListingEditPage(listing, [], TEST_SESSION);
    expect(html).toContain("<legend>Basics</legend>");
    expect(html).toContain("<legend>Tickets &amp; Pricing</legend>");
    expect(html).toContain("<legend>Daily Scheduling</legend>");
    expect(html).toContain(
      "<legend>Booking Duration &amp; Day Prices</legend>",
    );
    expect(html).toContain("<legend>Options &amp; Visibility</legend>");
    expect(html).toContain("<summary>Advanced settings</summary>");
  });

  test("renders the day-prices block immediately after the customisable-days checkbox", () => {
    const listing = testListingWithCount({
      customisable_days: true,
      day_prices: { 1: 1000 },
      duration_days: 1,
    });
    const html = adminListingEditPage(listing, [], TEST_SESSION);
    const customisableIdx = html.indexOf('name="customisable_days"');
    const dayPriceIdx = html.indexOf('name="day_price_1"');
    const contactFieldsIdx = html.indexOf('name="fields"');
    // The prices follow the checkbox, and both sit before the later Options
    // section — i.e. no longer dumped at the bottom of the form.
    expect(customisableIdx).toBeGreaterThan(-1);
    expect(customisableIdx).toBeLessThan(dayPriceIdx);
    expect(dayPriceIdx).toBeLessThan(contactFieldsIdx);
  });

  test("places the technical fields inside the Advanced disclosure", () => {
    const listing = testListingWithCount();
    const html = adminListingEditPage(listing, [], TEST_SESSION);
    const advancedIdx = html.indexOf("<summary>Advanced settings</summary>");
    expect(advancedIdx).toBeGreaterThan(-1);
    expect(advancedIdx).toBeLessThan(html.indexOf('name="webhook_url"'));
    expect(advancedIdx).toBeLessThan(html.indexOf('name="thank_you_url"'));
    expect(advancedIdx).toBeLessThan(html.indexOf('name="slug"'));
  });

  test("renders editable running totals with a recalculation link", () => {
    const listing = testListingWithCount({
      attendee_count: 7,
      tickets_count: 3,
    });
    const html = adminListingEditPage(listing, [], TEST_SESSION);
    expect(html).toContain("<legend>Running totals</legend>");
    expect(html).toContain("Accuracy is not guaranteed");
    expect(html).toContain('name="booked_quantity"');
    expect(html).toContain('value="7"');
    expect(html).toContain('name="tickets_count"');
    expect(html).toContain('value="3"');
    // Income is not a count override in the running-totals form — that form keeps
    // only the two count aggregates, which post to the recalculate route.
    const totalsForm = html.slice(
      html.indexOf("<legend>Running totals</legend>"),
      html.indexOf("Adjust income"),
    );
    expect(totalsForm).not.toContain('name="income"');
    expect(html).toContain(`/admin/listings/recalculate/${listing.id}`);
  });

  test("renders the separate income-correction form (decision 14)", () => {
    const listing = testListingWithCount();
    const html = adminListingEditPage(listing, [], TEST_SESSION);
    // Income correction is restored as a dedicated warned form that posts a
    // writeoff adjustment to the money ledger, kept apart from the counts override.
    expect(html).toContain("<h2>Adjust income</h2>");
    expect(html).toContain(`action="/admin/listing/${listing.id}/income"`);
    expect(html).toContain('name="income"');
    expect(html).toContain("correcting entry to the money ledger");
  });

  test("links from the income form to the detail page's income & ledger breakdown", () => {
    const listing = testListingWithCount({ id: 4 });
    const html = adminListingEditPage(listing, [], TEST_SESSION);
    // A compact pointer beside the adjust-income form to the full reconciliation
    // section on the detail page, so the two figures are explained in one place.
    expect(html).toContain('href="/admin/listing/4#income-ledger"');
    expect(html).toContain("Income &amp; ledger breakdown");
  });

  test("shows a running-total mismatch on the edit page", () => {
    const listing = testListingWithCount({
      attendee_count: 7,
      tickets_count: 3,
    });
    const html = adminListingEditPage(listing, [], TEST_SESSION, undefined, {
      booked_quantity: { current: 7, recalculated: 4 },
      tickets_count: { current: 3, recalculated: 3 },
    });
    expect(html).toContain("Mismatch");
    expect(html).toContain("expected <strong>4</strong>, got");
    expect(html).toContain(`/admin/listings/recalculate/${listing.id}`);
  });
});

describe("adminListingRecalculatePage", () => {
  test("shows current and attendee-derived totals with checkboxes", () => {
    const listing = testListingWithCount({ name: "Workshop" });
    const html = adminListingRecalculatePage(
      listing,
      {
        booked_quantity: { current: 9, recalculated: 4 },
        tickets_count: { current: 5, recalculated: 2 },
      },
      TEST_SESSION,
    );
    expect(html).toContain("Recalculate: Workshop");
    expect(html).toContain("Current");
    expect(html).toContain("From attendee data");
    expect(html).toContain("Compare the stored listing totals");
    expect(html).toContain('class="table-scroll"');
    expect(html).toContain('name="recalculate_fields"');
    expect(html).toContain('value="booked_quantity"');
    expect(html).toContain(">9<");
    expect(html).toContain(">4<");
  });
});

describe("adminListingEditPage Advanced section auto-open", () => {
  test("stays collapsed when only the slug is set", () => {
    // Slug is always populated; on its own it must not force the section open.
    const listing = testListingWithCount({
      thank_you_url: "",
      webhook_url: "",
    });
    const html = adminListingEditPage(listing, [], TEST_SESSION);
    expect(html).toContain('<details class="listing-advanced">');
    expect(html).not.toContain('<details class="listing-advanced" open>');
  });

  test("opens when a thank-you URL is set", () => {
    const listing = testListingWithCount({
      thank_you_url: "https://example.com/thanks",
      webhook_url: "",
    });
    const html = adminListingEditPage(listing, [], TEST_SESSION);
    expect(html).toContain('<details class="listing-advanced" open>');
  });

  test("opens when a webhook URL is set", () => {
    const listing = testListingWithCount({
      thank_you_url: "",
      webhook_url: "https://hooks.example.com/notify",
    });
    const html = adminListingEditPage(listing, [], TEST_SESSION);
    expect(html).toContain('<details class="listing-advanced" open>');
  });

  test("opens on a validation error so hidden fields stay reachable", () => {
    const listing = testListingWithCount({
      thank_you_url: "",
      webhook_url: "",
    });
    const html = adminListingEditPage(listing, [], TEST_SESSION, "Bad input");
    expect(html).toContain('<details class="listing-advanced" open>');
  });
});

describe("adminListingNewPage Advanced section", () => {
  test("renders collapsed by default", () => {
    const html = adminListingNewPage([], TEST_SESSION);
    expect(html).toContain('<details class="listing-advanced">');
    expect(html).not.toContain('<details class="listing-advanced" open>');
  });

  test("opens when re-rendered with an error", () => {
    const html = adminListingNewPage([], TEST_SESSION, {
      error: "Something went wrong",
    });
    expect(html).toContain('<details class="listing-advanced" open>');
  });
});

describe("adminListingEditPage Advanced section auto-open (builder fields)", () => {
  const withBuilder = (fn: () => void): void => {
    Deno.env.set("CAN_BUILD_SITES", "true");
    try {
      fn();
    } finally {
      Deno.env.delete("CAN_BUILD_SITES");
    }
  };

  test("opens when a renewal tier (months per unit) is set", () => {
    withBuilder(() => {
      const listing = testListingWithCount({
        months_per_unit: 3,
        thank_you_url: "",
        webhook_url: "",
      });
      const html = adminListingEditPage(listing, [], TEST_SESSION);
      expect(html).toContain('<details class="listing-advanced" open>');
    });
  });

  test("opens when initial site months is set", () => {
    withBuilder(() => {
      const listing = testListingWithCount({
        initial_site_months: 6,
        months_per_unit: 0,
        thank_you_url: "",
        webhook_url: "",
      });
      const html = adminListingEditPage(listing, [], TEST_SESSION);
      expect(html).toContain('<details class="listing-advanced" open>');
    });
  });

  test("opens when a built site is assigned on booking", () => {
    withBuilder(() => {
      const listing = testListingWithCount({
        assign_built_site: true,
        initial_site_months: 0,
        months_per_unit: 0,
        thank_you_url: "",
        webhook_url: "",
      });
      const html = adminListingEditPage(listing, [], TEST_SESSION);
      expect(html).toContain('<details class="listing-advanced" open>');
    });
  });

  test("stays collapsed when no advanced field is set even with the builder enabled", () => {
    withBuilder(() => {
      const listing = testListingWithCount({
        assign_built_site: false,
        initial_site_months: 0,
        months_per_unit: 0,
        thank_you_url: "",
        webhook_url: "",
      });
      const html = adminListingEditPage(listing, [], TEST_SESSION);
      expect(html).toContain('<details class="listing-advanced">');
      expect(html).not.toContain('<details class="listing-advanced" open>');
    });
  });
});

describe("adminListingPage duration display", () => {
  test("shows booking duration row for daily listings", () => {
    const listing = testListingWithCount({
      attendee_count: 0,
      duration_days: 3,
      listing_type: "daily",
    });
    const html = adminListingPage({
      allowedDomain: "localhost",
      attendees: [],
      listing,
      session: TEST_SESSION,
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
    const html = adminListingPage({
      allowedDomain: "localhost",
      attendees: [],
      listing,
      session: TEST_SESSION,
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
    const html = adminListingPage({
      allowedDomain: "localhost",
      attendees: [],
      listing,
      session: TEST_SESSION,
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
    const html = adminListingPage({
      allowedDomain: "localhost",
      attendees: [],
      listing,
      session: TEST_SESSION,
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
    const html = adminListingPage({
      allowedDomain: "localhost",
      attendees: [],
      listing,
      session: TEST_SESSION,
    });
    expect(html).toContain("No day prices set");
  });

  test("omits the customisable-days row for a fixed-duration listing", () => {
    const listing = testListingWithCount({
      attendee_count: 0,
      customisable_days: false,
    });
    const html = adminListingPage({
      allowedDomain: "localhost",
      attendees: [],
      listing,
      session: TEST_SESSION,
    });
    expect(html).not.toContain("Customisable Days");
  });
});

describe("adminListingPage", () => {
  const listing = testListingWithCount({ attendee_count: 2 });

  test("renders listing name", () => {
    const html = adminListingPage({
      allowedDomain: "localhost",
      attendees: [],
      listing,
      session: TEST_SESSION,
    });
    expect(html).toContain("Test Listing");
  });

  test("shows the listing ticket price in the details table", () => {
    const paidListing = testListingWithCount({ unit_price: 1250 });
    const html = adminListingPage({
      allowedDomain: "localhost",
      attendees: [],
      listing: paidListing,
      session: TEST_SESSION,
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
    const html = adminListingPage({
      allowedDomain: "localhost",
      attendees: [],
      listing: payMoreListing,
      session: TEST_SESSION,
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
    const html = adminListingPage({
      allowedDomain: "localhost",
      attendees: [],
      listing: payMoreListing,
      session: TEST_SESSION,
    });
    expect(html).toContain("Ticket Price");
    expect(html).toContain("Free");
    expect(html).toContain("pay more enabled");
  });

  test("shows free when the listing has no ticket price", () => {
    const freeListing = testListingWithCount({ unit_price: 0 });
    const html = adminListingPage({
      allowedDomain: "localhost",
      attendees: [],
      listing: freeListing,
      session: TEST_SESSION,
    });
    expect(html).toContain("Ticket Price");
    expect(html).toContain("Free");
  });

  test("shows attendees row with count and remaining", () => {
    const html = adminListingPage({
      allowedDomain: "localhost",
      attendees: [],
      listing,
      session: TEST_SESSION,
    });
    expect(html).toContain("Listing Attendees");
    expect(html).toContain("2 / 100");
    expect(html).toContain("98 remain");
  });

  test("shows a running-total mismatch in the details table", () => {
    const html = adminListingPage({
      aggregateRecalculation: {
        booked_quantity: { current: 2, recalculated: 1 },
        tickets_count: { current: 0, recalculated: 0 },
      },
      allowedDomain: "localhost",
      attendees: [],
      listing,
      session: TEST_SESSION,
    });
    expect(html).toContain("Running total check");
    expect(html).toContain("expected <strong>1</strong>, got");
    expect(html).toContain("Mismatch");
    expect(html).not.toContain("Click for info");
  });

  test("renders no Group Attendees row when groupContext is omitted", () => {
    const html = adminListingPage({
      allowedDomain: "localhost",
      attendees: [],
      listing,
      session: TEST_SESSION,
    });
    expect(html).not.toContain("Group Attendees");
  });

  test("shows Group Attendees row with count, cap, remaining, and link", () => {
    const group = testGroup({
      id: 7,
      max_attendees: 50,
      name: "Summer Festival",
    });
    const html = adminListingPage({
      allowedDomain: "localhost",
      attendees: [],
      groupContext: { attendeeCount: 30, group },
      listing,
      session: TEST_SESSION,
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
    const html = adminListingPage({
      allowedDomain: "localhost",
      attendees: [],
      groupContext: { attendeeCount: 10, group },
      listing,
      session: TEST_SESSION,
    });
    expect(html).toContain("danger-text");
    expect(html).toContain("10 / 10");
    expect(html).toContain("0 remain");
  });

  test("shows checked in row with 0 of 0 when no attendees", () => {
    const html = adminListingPage({
      allowedDomain: "localhost",
      attendees: [],
      listing,
      session: TEST_SESSION,
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
    const html = adminListingPage({
      allowedDomain: "localhost",
      attendees,
      listing,
      session: TEST_SESSION,
    });
    expect(html).toContain("Checked In");
    expect(html).toContain("1 / 3");
    expect(html).toContain("2 remain");
  });

  test("shows dual checked-in rows when attendees have multi-quantity", () => {
    const attendees = [
      testAttendee({ checked_in: true, id: 1, quantity: 2 }),
      testAttendee({ checked_in: false, id: 2, quantity: 3 }),
    ];
    const html = adminListingPage({
      allowedDomain: "localhost",
      attendees,
      listing,
      session: TEST_SESSION,
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
    const dailyListing = testListingWithCount({
      attendee_count: 5,
      listing_type: "daily",
    });
    const attendees = [
      testAttendee({ checked_in: true, id: 1, quantity: 2 }),
      testAttendee({ checked_in: false, id: 2, quantity: 3 }),
    ];
    const html = adminListingPage({
      allowedDomain: "localhost",
      attendees,
      dateFilter: "2026-03-15",
      listing: dailyListing,
      session: TEST_SESSION,
    });
    expect(html).toContain("Attendees Checked In (Sunday 15 March 2026)");
    expect(html).toContain("Tickets Checked In (Sunday 15 March 2026)");
  });

  test("dual checked-in rows show total suffix when daily listing without dateFilter", () => {
    const dailyListing = testListingWithCount({
      attendee_count: 5,
      listing_type: "daily",
    });
    const attendees = [
      testAttendee({ checked_in: true, id: 1, quantity: 2 }),
      testAttendee({ checked_in: false, id: 2, quantity: 3 }),
    ];
    const html = adminListingPage({
      allowedDomain: "localhost",
      attendees,
      listing: dailyListing,
      session: TEST_SESSION,
    });
    expect(html).toContain("Attendees Checked In (total)");
    expect(html).toContain("Tickets Checked In (total)");
  });

  test("shows thank you URL in copyable input", () => {
    const html = adminListingPage({
      allowedDomain: "localhost",
      attendees: [],
      listing,
      session: TEST_SESSION,
    });
    expect(html).toContain("Thank You URL");
    expect(html).toContain('value="https://example.com/thanks"');
    expect(html).toContain("readonly");
    expect(html).toContain("data-select-on-click");
  });

  test("shows public URL with allowed domain", () => {
    const html = adminListingPage({
      allowedDomain: "example.com",
      attendees: [],
      listing,
      session: TEST_SESSION,
    });
    expect(html).toContain("Public URL");
    expect(html).toContain('href="https://example.com/ticket/ab12c"');
    expect(html).toContain("example.com/ticket/ab12c");
  });

  test("shows collapsed embed codes with allowed domain and iframe param", () => {
    const html = adminListingPage({
      allowedDomain: "example.com",
      attendees: [],
      listing,
      session: TEST_SESSION,
    });
    expect(html).toContain('for="embed-toggle-1"');
    expect(html).toContain('class="embed-toggle-badge"');
    expect(html).toContain('class="visually-hidden listing-embed-toggle"');
    expect(html).toContain('class="listing-embed-row"');
    expect(html).toContain("Embed Script");
    expect(html).toContain("Embed Iframe");
    expect(html).toContain("embed.js");
    expect(html).toContain("data-listings=");
    expect(html).toContain("https://example.com/ticket/ab12c?iframe=true");
    expect(html).toContain("height: 600px");
    expect(html).toContain("loading=");
    expect(html).toContain("readonly");
  });

  test("iframe embed is a plain iframe without resizer scripts", () => {
    const html = adminListingPage({
      allowedDomain: "example.com",
      attendees: [],
      listing,
      session: TEST_SESSION,
    });
    expect(html).not.toContain("iframeResize");
  });

  test("renders empty attendees state", () => {
    const html = adminListingPage({
      allowedDomain: "localhost",
      attendees: [],
      listing,
      session: TEST_SESSION,
    });
    expect(html).toContain("No attendees yet");
  });

  test("renders attendees table", () => {
    const attendees = [testAttendee()];
    const html = adminListingPage({
      allowedDomain: "localhost",
      attendees,
      listing,
      session: TEST_SESSION,
    });
    expect(html).toContain("John Doe");
    expect(html).toContain("john@example.com");
  });

  test("escapes attendee data", () => {
    const attendees = [testAttendee({ name: "<script>evil()</script>" })];
    const html = adminListingPage({
      allowedDomain: "localhost",
      attendees,
      listing,
      session: TEST_SESSION,
    });
    expect(html).toContain("&lt;script&gt;");
  });

  test("includes back link", () => {
    const html = adminListingPage({
      allowedDomain: "localhost",
      attendees: [],
      listing,
      session: TEST_SESSION,
    });
    expect(html).toContain("/admin/");
  });

  test("shows phone column when attendee has phone", () => {
    const attendees = [testAttendee({ phone: "+1 555 123 4567" })];
    const html = adminListingPage({
      allowedDomain: "localhost",
      attendees,
      listing,
      session: TEST_SESSION,
    });
    expect(html).toContain("<th>Phone</th>");
    expect(html).toContain("+1 555 123 4567");
  });

  test("hides phone column when no attendees have phone", () => {
    const attendees = [testAttendee({ phone: "" })];
    const html = adminListingPage({
      allowedDomain: "localhost",
      attendees,
      listing,
      session: TEST_SESSION,
    });
    expect(html).not.toContain("<th>Phone</th>");
  });

  test("hides email column when no attendees have email", () => {
    const attendees = [testAttendee({ email: "" })];
    const html = adminListingPage({
      allowedDomain: "localhost",
      attendees,
      listing,
      session: TEST_SESSION,
    });
    expect(html).toContain("John Doe");
    expect(html).not.toContain("<th>Email</th>");
  });

  test("shows danger-text class when near capacity", () => {
    const nearFullListing = testListingWithCount({
      attendee_count: 91,
      max_attendees: 100,
    });
    const html = adminListingPage({
      allowedDomain: "localhost",
      attendees: [],
      listing: nearFullListing,
      session: TEST_SESSION,
    });
    expect(html).toContain('class="danger-text"');
    expect(html).toContain("9 remain");
  });

  test("does not show danger-text class when not near capacity", () => {
    const html = adminListingPage({
      allowedDomain: "localhost",
      attendees: [],
      listing,
      session: TEST_SESSION,
    });
    expect(html).not.toContain('class="danger-text"');
  });

  test("shows deactivated alert for inactive listings", () => {
    const inactive = testListingWithCount({ active: false, attendee_count: 0 });
    const html = adminListingPage({
      allowedDomain: "localhost",
      attendees: [],
      listing: inactive,
      session: TEST_SESSION,
    });
    expect(html).toContain('class="error"');
    expect(html).toContain("This listing is deactivated and cannot be booked");
  });

  test("does not show deactivated alert for active listings", () => {
    const html = adminListingPage({
      allowedDomain: "localhost",
      attendees: [],
      listing,
      session: TEST_SESSION,
    });
    expect(html).not.toContain(
      "This listing is deactivated and cannot be booked",
    );
  });

  test("shows ticket column header", () => {
    const html = adminListingPage({
      allowedDomain: "localhost",
      attendees: [],
      listing,
      session: TEST_SESSION,
    });
    expect(html).toContain("<th>Ticket</th>");
  });

  test("shows ticket token as link to public ticket URL", () => {
    const attendees = [testAttendee({ ticket_token: "abc123" })];
    const html = adminListingPage({
      allowedDomain: "mysite.com",
      attendees,
      listing,
      session: TEST_SESSION,
    });
    expect(html).toContain('href="https://mysite.com/t/abc123"');
    expect(html).toContain("abc123");
  });

  test("renders empty date cell for attendee without date on daily listing", () => {
    const dailyListing = testListingWithCount({
      attendee_count: 1,
      listing_type: "daily",
    });
    const attendees = [testAttendee({ date: null })];
    const html = adminListingPage({
      allowedDomain: "localhost",
      attendees,
      listing: dailyListing,
      session: TEST_SESSION,
    });
    expect(html).toContain("<th>Date</th>");
  });

  test("shows unlimited booking window when maximum_days_after is 0", () => {
    const dailyListing = testListingWithCount({
      listing_type: "daily",
      maximum_days_after: 0,
    });
    const html = adminListingPage({
      allowedDomain: "localhost",
      attendees: [],
      listing: dailyListing,
      session: TEST_SESSION,
    });
    expect(html).toContain("unlimited");
  });

  test("shows numeric booking window when maximum_days_after is nonzero", () => {
    const dailyListing = testListingWithCount({
      listing_type: "daily",
      maximum_days_after: 30,
    });
    const html = adminListingPage({
      allowedDomain: "localhost",
      attendees: [],
      listing: dailyListing,
      session: TEST_SESSION,
    });
    expect(html).toContain("to 30 days");
    expect(html).not.toContain("unlimited");
  });

  test("shows danger-text for daily listing at capacity with date filter", () => {
    const dailyListing = testListingWithCount({
      attendee_count: 0,
      listing_type: "daily",
      max_attendees: 2,
    });
    const attendees = [testAttendee(), testAttendee({ id: 2, name: "Jane" })];
    const html = adminListingPage({
      allowedDomain: "localhost",
      attendees,
      dateFilter: "2026-03-15",
      listing: dailyListing,
      session: TEST_SESSION,
    });
    expect(html).toContain('class="danger-text"');
    expect(html).toContain("0 remain");
  });
});

describe("adminListingNewPage", () => {
  test("renders create listing form fields", () => {
    const html = adminListingNewPage([], TEST_SESSION);
    expect(html).toContain("Add Listing");
    expect(html).toContain('name="name"');
    expect(html).toContain('name="max_attendees"');
    expect(html).toContain('name="thank_you_url"');
    expect(html).toContain('name="unit_price"');
    expect(html).toContain("Ticket Price");
  });

  test("renders breadcrumb back link", () => {
    const html = adminListingNewPage([], TEST_SESSION);
    expect(html).toContain('href="/admin/"');
    expect(html).toContain("Listings");
  });

  test("renders group select when groups exist", () => {
    const groups = [testGroup({ id: 2, name: "My Group" })];
    const html = adminListingNewPage(groups, TEST_SESSION);
    expect(html).toContain('name="group_id"');
    expect(hasSelectedOption(html, "0")).toBe(true);
    expect(html).toContain('value="2"');
    expect(html).toContain("My Group");
  });

  test("renders error when provided", () => {
    const html = adminListingNewPage([], TEST_SESSION, {
      error: "Something went wrong",
    });
    expect(html).toContain("Something went wrong");
  });

  test("applies listing-form--hide-type class for templates with a fixed listing_type", () => {
    const html = adminListingNewPage([], TEST_SESSION, {
      templateId: "weekly-event",
    });
    expect(html).toContain("listing-form--hide-type");
  });

  test("does not apply listing-form--hide-type for templates with no fixed listing_type", () => {
    const html = adminListingNewPage([], TEST_SESSION, {
      templateId: "hireable-item",
    });
    expect(html).not.toContain("listing-form--hide-type");
    expect(html).toContain("listing-form--templated");
  });
});

describe("adminListingPage export button", () => {
  test("renders export CSV button", () => {
    const listing = testListingWithCount({ attendee_count: 2 });
    const html = adminListingPage({
      allowedDomain: "localhost",
      attendees: [],
      listing,
      session: TEST_SESSION,
    });
    expect(html).toContain("/admin/listing/1/export");
    expect(html).toContain("Export CSV");
  });

  test("the export link carries the active check-in filter", () => {
    const html = adminListingPage({
      activeFilter: "in",
      allowedDomain: "localhost",
      attendees: [testAttendee({ checked_in: true })],
      listing: testListingWithCount({ attendee_count: 1 }),
      session: TEST_SESSION,
    });
    expect(html).toContain("/admin/listing/1/export?checkin=in");
  });
});

describe("adminListingPage filter links", () => {
  test("renders All / Checked In / Checked Out links", () => {
    const listing = testListingWithCount({ attendee_count: 1 });
    const attendees = [testAttendee()];
    const html = adminListingPage({
      allowedDomain: "localhost",
      attendees,
      listing,
      session: TEST_SESSION,
    });
    expect(html).toContain("All");
    expect(html).toContain("Checked In");
    expect(html).toContain("Checked Out");
  });

  test("bolds All when no filter is active", () => {
    const listing = testListingWithCount({ attendee_count: 1 });
    const attendees = [testAttendee()];
    const html = adminListingPage({
      allowedDomain: "localhost",
      attendees,
      listing,
      session: TEST_SESSION,
    });
    expect(html).toContain("<strong>All</strong>");
    expect(html).toContain(`href="/admin/listing/${listing.id}/in#attendees"`);
    expect(html).toContain(`href="/admin/listing/${listing.id}/out#attendees"`);
  });

  test("bolds Checked In when filter is in", () => {
    const listing = testListingWithCount({ attendee_count: 1 });
    const attendees = [testAttendee()];
    const html = adminListingPage({
      activeFilter: "in",
      allowedDomain: "localhost",
      attendees,
      listing,
      session: TEST_SESSION,
    });
    expect(html).toContain("<strong>Checked In</strong>");
    expect(html).toContain(`href="/admin/listing/${listing.id}#attendees"`);
  });

  test("bolds Checked Out when filter is out", () => {
    const listing = testListingWithCount({ attendee_count: 1 });
    const attendees = [testAttendee()];
    const html = adminListingPage({
      activeFilter: "out",
      allowedDomain: "localhost",
      attendees,
      listing,
      session: TEST_SESSION,
    });
    expect(html).toContain("<strong>Checked Out</strong>");
  });

  test("filters to only checked-in attendees when filter is in", () => {
    const listing = testListingWithCount({ attendee_count: 2 });
    const attendees = [
      testAttendee({ checked_in: true, id: 1, name: "Checked In User" }),
      testAttendee({ checked_in: false, id: 2, name: "Not Checked In User" }),
    ];
    const html = adminListingPage({
      activeFilter: "in",
      allowedDomain: "localhost",
      attendees,
      listing,
      session: TEST_SESSION,
    });
    expect(html).toContain("Checked In User");
    expect(html).not.toContain("Not Checked In User");
  });

  test("filters to only checked-out attendees when filter is out", () => {
    const listing = testListingWithCount({ attendee_count: 2 });
    const attendees = [
      testAttendee({ checked_in: true, id: 1, name: "Alice InPerson" }),
      testAttendee({ checked_in: false, id: 2, name: "Bob Remote" }),
    ];
    const html = adminListingPage({
      activeFilter: "out",
      allowedDomain: "localhost",
      attendees,
      listing,
      session: TEST_SESSION,
    });
    expect(html).not.toContain("Alice InPerson");
    expect(html).toContain("Bob Remote");
  });

  test("shows all attendees when filter is all", () => {
    const listing = testListingWithCount({ attendee_count: 2 });
    const attendees = [
      testAttendee({ checked_in: true, id: 1, name: "Checked In User" }),
      testAttendee({ checked_in: false, id: 2, name: "Not Checked In User" }),
    ];
    const html = adminListingPage({
      activeFilter: "all",
      allowedDomain: "localhost",
      attendees,
      listing,
      session: TEST_SESSION,
    });
    expect(html).toContain("Checked In User");
    expect(html).toContain("Not Checked In User");
  });

  test("includes return_filter hidden field in checkin form", () => {
    const listing = testListingWithCount({ attendee_count: 1 });
    const attendees = [testAttendee({ checked_in: true })];
    const html = adminListingPage({
      activeFilter: "in",
      allowedDomain: "localhost",
      attendees,
      listing,
      session: TEST_SESSION,
    });
    expect(html).toContain('name="return_filter"');
    expect(html).toContain('value="in"');
  });
});

describe("adminListingPage total revenue", () => {
  test("shows total revenue for paid listings", () => {
    const listing = testListingWithCount({
      attendee_count: 2,
      unit_price: 1000,
    });
    const attendees = [
      testAttendee({ payment_id: "pi_test_1", price_paid: "1000" }),
      testAttendee({ id: 2, payment_id: "pi_test_2", price_paid: "2000" }),
    ];
    const html = adminListingPage({
      allowedDomain: "localhost",
      attendees,
      listing,
      session: TEST_SESSION,
    });
    expect(html).toContain("Total Revenue");
    expect(html).toContain("£30");
  });

  test("does not show total revenue for free listings", () => {
    const listing = testListingWithCount({ attendee_count: 1, unit_price: 0 });
    const attendees = [testAttendee()];
    const html = adminListingPage({
      allowedDomain: "localhost",
      attendees,
      listing,
      session: TEST_SESSION,
    });
    expect(html).not.toContain("Total Revenue");
  });

  test("shows zero revenue for paid listing with no attendees", () => {
    const listing = testListingWithCount({
      attendee_count: 0,
      unit_price: 1000,
    });
    const html = adminListingPage({
      allowedDomain: "localhost",
      attendees: [],
      listing,
      session: TEST_SESSION,
    });
    expect(html).toContain("Total Revenue");
    expect(html).toContain("£0");
  });
});

describe("adminListingPage income & ledger breakdown", () => {
  const listing = testListingWithCount({ id: 7 });

  test("omits the section entirely when no breakdown is supplied", () => {
    const html = adminListingPage({
      allowedDomain: "localhost",
      attendees: [],
      listing,
      session: TEST_SESSION,
    });
    expect(html).not.toContain("Income &amp; ledger");
  });

  test("renders the five figures, the explanatory line and the ledger link", () => {
    const html = adminListingPage({
      allowedDomain: "localhost",
      attendees: [],
      listing,
      revenueBreakdown: {
        externalCosts: 0,
        externalIncome: 0,
        grossSales: 10000,
        manualAdjustments: -1000,
        netBalance: 7000,
        recognisedIncome: 9000,
        refunds: 2000,
      },
      session: TEST_SESSION,
    });
    expect(html).toContain("Income &amp; ledger");
    // Gross sales credited (+), manual write-down (−), then the two subtotals.
    expect(html).toContain("Gross ticket sales");
    expect(html).toContain("+£100");
    expect(html).toContain("Manual adjustments");
    expect(html).toContain("−£10");
    expect(html).toContain("Recognised income");
    expect(html).toContain("£90");
    expect(html).toContain("Refunds");
    expect(html).toContain("−£20");
    expect(html).toContain("Net balance in ledger");
    expect(html).toContain("£70");
    // The plain-English reconciliation note and the button to the filtered
    // ledger, preselected to this listing (no arrow glyph, button-styled).
    expect(html).toContain("refund-agnostic");
    expect(html).toContain('href="/admin/ledger?listing=7"');
    expect(html).toContain("View full ledger");
    expect(html).not.toContain("View full ledger →");
  });

  test("makes a refund-driven divergence between income and net balance visible", () => {
    // Recognised income (£90) and the net ledger balance (£70) legitimately
    // differ after a refund; both must render so the reconciliation is shown.
    const html = adminListingPage({
      allowedDomain: "localhost",
      attendees: [],
      listing,
      revenueBreakdown: {
        externalCosts: 0,
        externalIncome: 0,
        grossSales: 9000,
        manualAdjustments: 0,
        netBalance: 7000,
        recognisedIncome: 9000,
        refunds: 2000,
      },
      session: TEST_SESSION,
    });
    const recognisedIdx = html.indexOf("Recognised income");
    const netIdx = html.indexOf("Net balance in ledger");
    expect(recognisedIdx).toBeGreaterThan(-1);
    expect(netIdx).toBeGreaterThan(netIdx === -1 ? 0 : recognisedIdx);
    expect(html).toContain("£90");
    expect(html).toContain("£70");
    // The two figures differ exactly by the refunds line.
    expect(html).toContain("−£20");
  });

  test("omits the manual-adjustments row when there are none", () => {
    const html = adminListingPage({
      allowedDomain: "localhost",
      attendees: [],
      listing,
      revenueBreakdown: {
        externalCosts: 0,
        externalIncome: 0,
        grossSales: 5000,
        manualAdjustments: 0,
        netBalance: 5000,
        recognisedIncome: 5000,
        refunds: 0,
      },
      session: TEST_SESSION,
    });
    expect(html).toContain("Income &amp; ledger");
    expect(html).not.toContain("Manual adjustments");
    // With no refunds either, recognised income and net balance coincide at £50.
    expect(html).toContain("Recognised income");
    expect(html).toContain("Net balance in ledger");
    expect(html).toContain("£50");
  });

  test("shows a signed positive manual write-up", () => {
    const html = adminListingPage({
      allowedDomain: "localhost",
      attendees: [],
      listing,
      revenueBreakdown: {
        externalCosts: 0,
        externalIncome: 0,
        grossSales: 4000,
        manualAdjustments: 1500,
        netBalance: 5500,
        recognisedIncome: 5500,
        refunds: 0,
      },
      session: TEST_SESSION,
    });
    expect(html).toContain("Manual adjustments");
    expect(html).toContain("+£15");
  });

  test("shows outside income and listing-specific costs when present", () => {
    const html = adminListingPage({
      allowedDomain: "localhost",
      attendees: [],
      listing,
      revenueBreakdown: {
        externalCosts: 300,
        externalIncome: 1200,
        grossSales: 4000,
        manualAdjustments: 0,
        netBalance: 4900,
        recognisedIncome: 5200,
        refunds: 0,
      },
      session: TEST_SESSION,
    });
    expect(html).toContain("Income received outside checkout");
    expect(html).toContain("+£12");
    expect(html).toContain("Costs paid outside checkout");
    expect(html).toContain("−£3");
  });

  test("shows a listing ledger add-entry action when the account exists", () => {
    const html = adminListingPage({
      allowedDomain: "localhost",
      attendees: [],
      ledger: {
        account: account("revenue", 7),
        lines: [],
        names: {
          ...emptyLedgerNames(),
          listings: new Map([[7, listing.name]]),
        },
      },
      listing,
      session: TEST_SESSION,
    });
    expect(html).toContain('<section id="ledger">');
    expect(html).toContain("Add entry");
    expect(html).toContain(
      'href="/admin/ledger/revenue/7/add?return_url=%2Fadmin%2Flisting%2F7"',
    );
  });
});

describe("adminListingPage optional fields", () => {
  test("shows reactivate link for inactive listings", () => {
    const listing = testListingWithCount({ active: false, attendee_count: 0 });
    const html = adminListingPage({
      allowedDomain: "localhost",
      attendees: [],
      listing,
      session: TEST_SESSION,
    });
    expect(html).toContain("/reactivate");
    expect(html).toContain("Reactivate");
  });

  test("hides thank you URL row when no thank_you_url", () => {
    const listing = testListingWithCount({
      attendee_count: 0,
      thank_you_url: "",
    });
    const html = adminListingPage({
      allowedDomain: "localhost",
      attendees: [],
      listing,
      session: TEST_SESSION,
    });
    expect(html).not.toContain("Thank You URL");
  });

  test("shows webhook URL in copyable input when present", () => {
    const listing = testListingWithCount({
      attendee_count: 0,
      webhook_url: "https://hooks.example.com/notify",
    });
    const html = adminListingPage({
      allowedDomain: "localhost",
      attendees: [],
      listing,
      session: TEST_SESSION,
    });
    expect(html).toContain("Webhook URL");
    expect(html).toContain('value="https://hooks.example.com/notify"');
    expect(html).toContain("readonly");
  });
});

describe("nearCapacity", () => {
  test("returns true when at 90% capacity", () => {
    const listing = testListingWithCount({
      attendee_count: 90,
      max_attendees: 100,
    });
    expect(nearCapacity(listing)).toBe(true);
  });

  test("returns true when over 90% capacity", () => {
    const listing = testListingWithCount({
      attendee_count: 95,
      max_attendees: 100,
    });
    expect(nearCapacity(listing)).toBe(true);
  });

  test("returns false when under 90% capacity", () => {
    const listing = testListingWithCount({
      attendee_count: 89,
      max_attendees: 100,
    });
    expect(nearCapacity(listing)).toBe(false);
  });

  test("returns true when fully sold out", () => {
    const listing = testListingWithCount({
      attendee_count: 100,
      max_attendees: 100,
    });
    expect(nearCapacity(listing)).toBe(true);
  });
});

describe("isIncompletePayment", () => {
  test("returns true for paid listing attendee with no payment_id and price > 0", () => {
    const attendee = testAttendee({ payment_id: "", price_paid: "1000" });
    expect(isIncompletePayment(attendee, true)).toBe(true);
  });

  test("returns false for free listing", () => {
    const attendee = testAttendee({ payment_id: "", price_paid: "0" });
    expect(isIncompletePayment(attendee, false)).toBe(false);
  });

  test("returns false for admin-added attendee on paid listing (price_paid=0)", () => {
    const attendee = testAttendee({ payment_id: "", price_paid: "0" });
    expect(isIncompletePayment(attendee, true)).toBe(false);
  });

  test("returns false for completed payment attendee", () => {
    const attendee = testAttendee({
      payment_id: "pi_test_123",
      price_paid: "1000",
    });
    expect(isIncompletePayment(attendee, true)).toBe(false);
  });
});

describe("completePaymentAttendees", () => {
  test("drops unresolved-payment rows on a paid listing", () => {
    const listing = testListingWithCount({ unit_price: 1000 });
    const paid = testAttendee({
      id: 1,
      payment_id: "pi_ok",
      price_paid: "1000",
    });
    const failed = testAttendee({ id: 2, payment_id: "", price_paid: "1000" });
    expect(completePaymentAttendees(listing, [paid, failed])).toEqual([paid]);
  });

  test("keeps every row on a free listing", () => {
    const listing = testListingWithCount({ unit_price: 0 });
    const a = testAttendee({ id: 1, payment_id: "", price_paid: "0" });
    const b = testAttendee({ id: 2, payment_id: "", price_paid: "1000" });
    expect(completePaymentAttendees(listing, [a, b])).toEqual([a, b]);
  });
});

describe("adminListingPage failed payments", () => {
  test("shows Failed Payments section when incomplete attendees exist", () => {
    const listing = testListingWithCount({
      attendee_count: 3,
      unit_price: 1000,
    });
    const attendees = [
      testAttendee({ id: 1, payment_id: "pi_ok", price_paid: "1000" }),
      testAttendee({ id: 2, payment_id: "", price_paid: "1000" }),
    ];
    const html = adminListingPage({
      allowedDomain: "localhost",
      attendees,
      listing,
      session: TEST_SESSION,
    });
    expect(html).toContain("Failed Payments");
    expect(html).toContain("1 attendee(s) with unresolved payments");
    expect(html).toContain("/delete-incomplete");
  });

  test("hides Failed Payments section when no incomplete attendees", () => {
    const listing = testListingWithCount({
      attendee_count: 1,
      unit_price: 1000,
    });
    const attendees = [
      testAttendee({ id: 1, payment_id: "pi_ok", price_paid: "1000" }),
    ];
    const html = adminListingPage({
      allowedDomain: "localhost",
      attendees,
      listing,
      session: TEST_SESSION,
    });
    expect(html).not.toContain("Failed Payments");
  });

  test("hides Failed Payments section for free listings", () => {
    const listing = testListingWithCount({ attendee_count: 1, unit_price: 0 });
    const attendees = [testAttendee({ id: 1, price_paid: "0" })];
    const html = adminListingPage({
      allowedDomain: "localhost",
      attendees,
      listing,
      session: TEST_SESSION,
    });
    expect(html).not.toContain("Failed Payments");
  });

  test("excludes incomplete attendees from attendee count", () => {
    const listing = testListingWithCount({
      attendee_count: 3,
      max_attendees: 100,
      unit_price: 1000,
    });
    const attendees = [
      testAttendee({ id: 1, payment_id: "pi_ok", price_paid: "1000" }),
      testAttendee({ id: 2, payment_id: "", price_paid: "1000" }),
    ];
    const html = adminListingPage({
      allowedDomain: "localhost",
      attendees,
      listing,
      session: TEST_SESSION,
    });
    // adjusted count: 3 - 1 (incomplete qty) = 2
    expect(html).toContain("2 / 100");
  });

  test("excludes incomplete attendees from checked-in count", () => {
    const listing = testListingWithCount({
      attendee_count: 2,
      unit_price: 1000,
    });
    const attendees = [
      testAttendee({
        checked_in: true,
        id: 1,
        payment_id: "pi_ok",
        price_paid: "1000",
      }),
      testAttendee({
        checked_in: true,
        id: 2,
        payment_id: "",
        price_paid: "1000",
      }),
    ];
    const html = adminListingPage({
      allowedDomain: "localhost",
      attendees,
      listing,
      session: TEST_SESSION,
    });
    // Only complete attendees count: 1 checked in / 1 total
    expect(html).toContain("1 / 1");
  });

  test("excludes incomplete attendees from revenue", () => {
    const listing = testListingWithCount({
      attendee_count: 2,
      unit_price: 1000,
    });
    const attendees = [
      testAttendee({ id: 1, payment_id: "pi_ok", price_paid: "1000" }),
      testAttendee({ id: 2, payment_id: "", price_paid: "2000" }),
    ];
    const html = adminListingPage({
      allowedDomain: "localhost",
      attendees,
      listing,
      session: TEST_SESSION,
    });
    expect(html).toContain("£10");
    expect(html).not.toContain("£30");
  });

  test("failed payments table has delete button but no check-in or refund", () => {
    const listing = testListingWithCount({
      attendee_count: 1,
      unit_price: 1000,
    });
    const attendees = [
      testAttendee({
        id: 1,
        name: "Jane Stuck",
        payment_id: "",
        price_paid: "1000",
      }),
    ];
    const html = adminListingPage({
      allowedDomain: "localhost",
      attendees,
      listing,
      session: TEST_SESSION,
    });
    const failedSection =
      html.split("Failed Payments")[1]?.split("Add Attendee")[0] ?? "";
    expect(failedSection).toContain("Jane Stuck");
    expect(failedSection).toContain("Delete");
    expect(failedSection).toContain("/delete-incomplete");
    expect(failedSection).not.toContain("Check in");
    expect(failedSection).not.toContain("Check out");
    expect(failedSection).not.toContain("Refund");
    expect(failedSection).not.toContain("Re-send Webhook");
  });
});

describe("adminListingPage listing date and location", () => {
  test("shows Listing Date row when listing has a date", () => {
    const listing = testListingWithCount({
      attendee_count: 0,
      date: "2026-06-15T14:00:00.000Z",
    });
    const html = adminListingPage({
      allowedDomain: "localhost",
      attendees: [],
      listing,
      session: TEST_SESSION,
    });
    expect(html).toContain("Listing Date");
    expect(html).toContain("Monday 15 June 2026 at 15:00 GMT+1");
  });

  test("does not show Listing Date row when date is empty", () => {
    const listing = testListingWithCount({ attendee_count: 0, date: "" });
    const html = adminListingPage({
      allowedDomain: "localhost",
      attendees: [],
      listing,
      session: TEST_SESSION,
    });
    expect(html).not.toContain("Listing Date");
  });

  test("shows Location row when listing has a location", () => {
    const listing = testListingWithCount({
      attendee_count: 0,
      location: "Village Hall",
    });
    const html = adminListingPage({
      allowedDomain: "localhost",
      attendees: [],
      listing,
      session: TEST_SESSION,
    });
    expect(html).toContain("<th>Location</th>");
    expect(html).toContain("Village Hall");
  });

  test("does not show Location row when location is empty", () => {
    const listing = testListingWithCount({ attendee_count: 0, location: "" });
    const html = adminListingPage({
      allowedDomain: "localhost",
      attendees: [],
      listing,
      session: TEST_SESSION,
    });
    expect(html).not.toContain("<th>Location</th>");
  });

  test("shows both Listing Date and Location when both are set", () => {
    const listing = testListingWithCount({
      attendee_count: 0,
      date: "2026-06-15T14:00:00.000Z",
      location: "Town Centre",
    });
    const html = adminListingPage({
      allowedDomain: "localhost",
      attendees: [],
      listing,
      session: TEST_SESSION,
    });
    expect(html).toContain("Listing Date");
    expect(html).toContain("Town Centre");
  });
});

describe("adminListingPage edit form pre-fills date and location", () => {
  test("empty date shows no pre-filled value in edit form", () => {
    const listing = testListingWithCount({ attendee_count: 0, date: "" });
    const html = adminListingEditPage(listing, [], TEST_SESSION, undefined);
    // The date field should render split date and time inputs
    expect(html).toContain('name="date_date"');
    expect(html).toContain('name="date_time"');
  });

  test("non-empty date shows formatted split values in edit form", () => {
    const listing = testListingWithCount({
      attendee_count: 0,
      date: "2026-06-15T14:00:00.000Z",
    });
    const html = adminListingEditPage(listing, [], TEST_SESSION, undefined);
    // Should contain split date and time values converted to Europe/London (BST = UTC+1)
    expect(html).toContain('value="2026-06-15"');
    expect(html).toContain('value="15:00"');
  });

  test("pre-fills location in edit form", () => {
    const listing = testListingWithCount({
      attendee_count: 0,
      location: "Village Hall",
    });
    const html = adminListingEditPage(listing, [], TEST_SESSION, undefined);
    expect(html).toContain('value="Village Hall"');
  });
});

describe("adminListingEditPage max_price field", () => {
  test("renders max_price field with value when set", () => {
    const listing = testListingWithCount({
      attendee_count: 0,
      can_pay_more: true,
      max_price: 50000,
    });
    const html = adminListingEditPage(listing, [], TEST_SESSION, undefined);
    expect(html).toContain('name="max_price"');
    expect(html).toContain('value="500.00"');
  });

  test("renders max_price field with 0.00 when zero", () => {
    const listing = testListingWithCount({
      attendee_count: 0,
      can_pay_more: true,
      max_price: 0,
    });
    const html = adminListingEditPage(listing, [], TEST_SESSION, undefined);
    expect(html).toContain('name="max_price"');
    expect(html).toContain('value="0.00"');
  });
});

describe("datetime validation via getListingFields() date field", () => {
  const dateField = getListingFields().find((f) => f.name === "date")!;

  test("accepts valid datetime value", () => {
    const result = dateField.validate?.("2026-06-15T14:00");
    expect(result).toBeNull();
  });

  test("rejects invalid datetime value", () => {
    const result = dateField.validate?.("not-a-date");
    expect(result).toBe("Please enter a valid date and time");
  });
});

describeWithEnv(
  "listing images",
  { env: { STORAGE_ZONE_KEY: "testkey", STORAGE_ZONE_NAME: "testzone" } },
  () => {
    describe("adminListingPage image section", () => {
      test("does not show image upload on detail page", () => {
        const listing = testListingWithCount({ image_url: "" });
        const html = adminListingPage({
          allowedDomain: "localhost",
          attendees: [],
          listing,
          session: TEST_SESSION,
        });
        expect(html).not.toContain('type="file"');
        expect(html).not.toContain('name="image"');
      });
    });

    describe("adminListingEditPage image section", () => {
      test("shows image upload field when storage enabled", () => {
        const listing = testListingWithCount({ image_url: "" });
        const html = adminListingEditPage(listing, [], TEST_SESSION);
        expect(html).toContain('type="file"');
        expect(html).toContain('name="image"');
        expect(html).toContain("multipart/form-data");
      });

      test("shows current image and remove button when image is set", () => {
        runWithStorageConfig(
          { zoneKey: "testkey", zoneName: "testzone" },
          () => {
            const listing = testListingWithCount({ image_url: "current.jpg" });
            const html = adminListingEditPage(listing, [], TEST_SESSION);
            expect(html).toContain("/image/current.jpg");
            expect(html).toContain("Remove Image");
            expect(html).toContain("/image/delete");
          },
        );
      });

      test("does not show image field when storage is not enabled", () => {
        withStorageDisabled(() => {
          const listing = testListingWithCount({ image_url: "" });
          const html = adminListingEditPage(listing, [], TEST_SESSION);
          expect(html).not.toContain('type="file"');
          expect(html).not.toContain('name="image"');
        });
      });

      test("shows full-width image preview when listing has image", () => {
        runWithStorageConfig(
          { zoneKey: "testkey", zoneName: "testzone" },
          () => {
            const listing = testListingWithCount({ image_url: "preview.jpg" });
            const html = adminListingEditPage(listing, [], TEST_SESSION);
            expect(html).toContain("listing-image-full");
            expect(html).toContain("/image/preview.jpg");
          },
        );
      });
    });

    describe("adminDuplicateListingPage image section", () => {
      test("shows image upload field when storage enabled", () => {
        runWithStorageConfig(
          { zoneKey: "testkey", zoneName: "testzone" },
          () => {
            const listing = testListingWithCount({ image_url: "" });
            const html = adminDuplicateListingPage(listing, [], TEST_SESSION);
            expect(html).toContain('type="file"');
            expect(html).toContain('name="image"');
            expect(html).toContain("multipart/form-data");
          },
        );
      });

      test("does not show image field when storage is not enabled", () => {
        withStorageDisabled(() => {
          const listing = testListingWithCount({ image_url: "" });
          const html = adminDuplicateListingPage(listing, [], TEST_SESSION);
          expect(html).not.toContain('type="file"');
          expect(html).not.toContain('name="image"');
        });
      });
    });

    describe("adminListingNewPage image section", () => {
      test("shows image upload field on create form when storage enabled", () => {
        runWithStorageConfig(
          { zoneKey: "testkey", zoneName: "testzone" },
          () => {
            const html = adminListingNewPage([], TEST_SESSION);
            expect(html).toContain('type="file"');
            expect(html).toContain('name="image"');
            expect(html).toContain("multipart/form-data");
          },
        );
      });

      test("does not show image field on create form when storage is not enabled", () => {
        withStorageDisabled(() => {
          const html = adminListingNewPage([], TEST_SESSION);
          expect(html).not.toContain('type="file"');
        });
      });
    });

    describe("assign_built_site field", () => {
      test("shows assign built site field when CAN_BUILD_SITES is true", () => {
        Deno.env.set("CAN_BUILD_SITES", "true");
        try {
          const html = adminListingNewPage([], TEST_SESSION);
          expect(html).toContain("assign_built_site");
          expect(html).toContain("Assign a site on booking");
        } finally {
          Deno.env.delete("CAN_BUILD_SITES");
        }
      });

      test("hides assign built site field when CAN_BUILD_SITES is not set", () => {
        Deno.env.delete("CAN_BUILD_SITES");
        const html = adminListingNewPage([], TEST_SESSION);
        expect(html).not.toContain("assign_built_site");
      });

      test("shows on edit page when CAN_BUILD_SITES is true", () => {
        Deno.env.set("CAN_BUILD_SITES", "true");
        try {
          const listing = testListingWithCount({ assign_built_site: true });
          const html = adminListingEditPage(listing, [], TEST_SESSION);
          expect(html).toContain("assign_built_site");
          expect(html).toContain("checked");
        } finally {
          Deno.env.delete("CAN_BUILD_SITES");
        }
      });

      test("shows on duplicate page when CAN_BUILD_SITES is true", () => {
        Deno.env.set("CAN_BUILD_SITES", "true");
        try {
          const listing = testListingWithCount({ assign_built_site: true });
          const html = adminDuplicateListingPage(listing, [], TEST_SESSION);
          expect(html).toContain("assign_built_site");
        } finally {
          Deno.env.delete("CAN_BUILD_SITES");
        }
      });
    });

    describe("months_per_unit and initial_site_months fields", () => {
      test("shows months_per_unit and initial_site_months when CAN_BUILD_SITES is true", () => {
        Deno.env.set("CAN_BUILD_SITES", "true");
        try {
          const html = adminListingNewPage([], TEST_SESSION);
          expect(html).toContain("months_per_unit");
          expect(html).toContain("Months Per Unit");
          expect(html).toContain("initial_site_months");
          expect(html).toContain("Initial Site Months");
        } finally {
          Deno.env.delete("CAN_BUILD_SITES");
        }
      });

      test("hides months_per_unit and initial_site_months when CAN_BUILD_SITES is not set", () => {
        Deno.env.delete("CAN_BUILD_SITES");
        const html = adminListingNewPage([], TEST_SESSION);
        expect(html).not.toContain("months_per_unit");
        expect(html).not.toContain("Months Per Unit");
        expect(html).not.toContain("initial_site_months");
        expect(html).not.toContain("Initial Site Months");
      });

      test("shows on edit page when CAN_BUILD_SITES is true", () => {
        Deno.env.set("CAN_BUILD_SITES", "true");
        try {
          const listing = testListingWithCount({
            initial_site_months: 6,
            months_per_unit: 3,
          });
          const html = adminListingEditPage(listing, [], TEST_SESSION);
          expect(html).toContain("months_per_unit");
          expect(html).toContain("initial_site_months");
        } finally {
          Deno.env.delete("CAN_BUILD_SITES");
        }
      });

      test("hides on edit page when CAN_BUILD_SITES is not set", () => {
        Deno.env.delete("CAN_BUILD_SITES");
        const listing = testListingWithCount({
          initial_site_months: 6,
          months_per_unit: 3,
        });
        const html = adminListingEditPage(listing, [], TEST_SESSION);
        expect(html).not.toContain("months_per_unit");
        expect(html).not.toContain("initial_site_months");
      });

      test("shows on duplicate page when CAN_BUILD_SITES is true", () => {
        Deno.env.set("CAN_BUILD_SITES", "true");
        try {
          const listing = testListingWithCount({
            initial_site_months: 6,
            months_per_unit: 3,
          });
          const html = adminDuplicateListingPage(listing, [], TEST_SESSION);
          expect(html).toContain("months_per_unit");
          expect(html).toContain("initial_site_months");
        } finally {
          Deno.env.delete("CAN_BUILD_SITES");
        }
      });

      test("hides on duplicate page when CAN_BUILD_SITES is not set", () => {
        Deno.env.delete("CAN_BUILD_SITES");
        const listing = testListingWithCount({
          initial_site_months: 6,
          months_per_unit: 3,
        });
        const html = adminDuplicateListingPage(listing, [], TEST_SESSION);
        expect(html).not.toContain("months_per_unit");
        expect(html).not.toContain("initial_site_months");
      });
    });
  },
);

describe("adminListingPage Renewal tag", () => {
  test("renders Renewal tag for tier listings with months_per_unit > 0", () => {
    const listing = testListingWithCount({ months_per_unit: 3 });
    const html = adminListingPage({
      allowedDomain: "",
      attendees: [],
      listing,
      session: TEST_SESSION,
    });
    expect(html).toContain("Renewal");
  });

  test("does not render Renewal tag for listings with months_per_unit = 0", () => {
    const listing = testListingWithCount({ months_per_unit: 0 });
    const html = adminListingPage({
      allowedDomain: "",
      attendees: [],
      listing,
      session: TEST_SESSION,
    });
    expect(html).not.toContain("Renewal");
  });
});
