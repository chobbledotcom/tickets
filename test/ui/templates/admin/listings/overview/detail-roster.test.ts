import { assert, assertStringIncludes } from "@std/assert";
import { describe, it as test } from "@std/testing/bdd";
import { ListingDeactivatedBanner } from "#templates/admin/listings/overview.tsx";
import {
  registerListingTemplateHooks,
  renderListingDetail,
} from "#test/ui/templates/admin/listings/helpers.ts";
import { testAttendee, testListingWithCount } from "#test-utils/factories.ts";

describe("adminListingPage roster and attendees", () => {
  registerListingTemplateHooks();

  const listing = testListingWithCount({ attendee_count: 2 });

  test("shows thank you URL in copyable input", () => {
    const html = renderListingDetail({
      allowedDomain: "localhost",
      attendees: [],
      listing,
    });
    assertStringIncludes(html, "Thank You URL");
    assertStringIncludes(html, 'value="https://example.com/thanks"');
    assertStringIncludes(html, "readonly");
    assertStringIncludes(html, "data-select-on-click");
  });

  test("shows public URL with allowed domain", () => {
    const html = renderListingDetail({
      allowedDomain: "example.com",
      attendees: [],
      listing,
    });
    assertStringIncludes(html, "Public URL");
    assertStringIncludes(html, 'href="https://example.com/ticket/ab12c"');
    assertStringIncludes(html, "example.com/ticket/ab12c");
  });

  test("shows collapsed embed codes with allowed domain and iframe param", () => {
    const html = renderListingDetail({
      allowedDomain: "example.com",
      attendees: [],
      listing,
    });
    assertStringIncludes(
      html,
      '<label class="small-action" for="embed-toggle-1">Embed</label>',
    );
    assertStringIncludes(html, 'class="visually-hidden embed-toggle"');
    assertStringIncludes(html, 'class="embed-code-row"');
    assertStringIncludes(html, "Embed Script");
    assertStringIncludes(html, "Embed Iframe");
    assertStringIncludes(html, "embed.js");
    assertStringIncludes(html, "data-listings=");
    assertStringIncludes(html, "https://example.com/ticket/ab12c?iframe=true");
    assertStringIncludes(html, "height: 600px");
    assertStringIncludes(html, "loading=");
    assertStringIncludes(html, "readonly");
  });

  test("iframe embed is a plain iframe without resizer scripts", () => {
    const html = renderListingDetail({
      allowedDomain: "example.com",
      attendees: [],
      listing,
    });
    assert(
      !html.includes("iframeResize"),
      "the value should not contain the searched item",
    );
  });

  test("renders empty attendees state", () => {
    const html = renderListingDetail({
      allowedDomain: "localhost",
      attendees: [],
      listing,
    });
    assertStringIncludes(html, "No attendees yet");
  });

  test("renders attendees table", () => {
    const attendees = [testAttendee()];
    const html = renderListingDetail({
      allowedDomain: "localhost",
      attendees,
      listing,
    });
    assertStringIncludes(html, "John Doe");
    assertStringIncludes(html, "john@example.com");
  });

  test("escapes attendee data", () => {
    const attendees = [testAttendee({ name: "<script>evil()</script>" })];
    const html = renderListingDetail({
      allowedDomain: "localhost",
      attendees,
      listing,
    });
    assertStringIncludes(html, "&lt;script&gt;");
  });

  test("includes back link", () => {
    const html = renderListingDetail({
      allowedDomain: "localhost",
      attendees: [],
      listing,
    });
    assertStringIncludes(html, "/admin/");
  });

  test("shows phone column when attendee has phone", () => {
    const attendees = [testAttendee({ phone: "+1 555 123 4567" })];
    const html = renderListingDetail({
      allowedDomain: "localhost",
      attendees,
      listing,
    });
    assertStringIncludes(html, "<th>Phone</th>");
    assertStringIncludes(html, "+1 555 123 4567");
  });

  test("hides phone column when no attendees have phone", () => {
    const attendees = [testAttendee({ phone: "" })];
    const html = renderListingDetail({
      allowedDomain: "localhost",
      attendees,
      listing,
    });
    assert(
      !html.includes("<th>Phone</th>"),
      "the value should not contain the searched item",
    );
  });

  test("hides email column when no attendees have email", () => {
    const attendees = [testAttendee({ email: "" })];
    const html = renderListingDetail({
      allowedDomain: "localhost",
      attendees,
      listing,
    });
    assertStringIncludes(html, "John Doe");
    assert(
      !html.includes("<th>Email</th>"),
      "the value should not contain the searched item",
    );
  });

  test("shows danger-text class when near capacity", () => {
    const nearFullListing = testListingWithCount({
      attendee_count: 91,
      max_attendees: 100,
    });
    const html = renderListingDetail({
      allowedDomain: "localhost",
      attendees: [],
      listing: nearFullListing,
    });
    assertStringIncludes(html, 'class="danger-text"');
    assertStringIncludes(html, "9 remain");
  });

  test("does not show danger-text class when not near capacity", () => {
    const html = renderListingDetail({
      allowedDomain: "localhost",
      attendees: [],
      listing,
    });
    assert(
      !html.includes('class="danger-text"'),
      "the value should not contain the searched item",
    );
  });

  test("shows deactivated alert for inactive listings", () => {
    const html = String(ListingDeactivatedBanner({ active: false }));
    assertStringIncludes(html, 'class="error"');
    assertStringIncludes(
      html,
      "This listing is deactivated and cannot be booked",
    );
  });

  test("does not show deactivated alert for active listings", () => {
    const html = String(ListingDeactivatedBanner({ active: true }));
    assert(
      !html.includes("This listing is deactivated and cannot be booked"),
      "the value should not contain the searched item",
    );
  });

  test("shows ticket column header", () => {
    const html = renderListingDetail({
      allowedDomain: "localhost",
      attendees: [],
      listing,
    });
    assertStringIncludes(html, "<th>Ticket</th>");
  });

  test("shows ticket token as link to public ticket URL", () => {
    const attendees = [testAttendee({ ticket_token: "abc123" })];
    const html = renderListingDetail({
      allowedDomain: "mysite.com",
      attendees,
      listing,
    });
    assertStringIncludes(html, 'href="https://mysite.com/t/abc123"');
    assertStringIncludes(html, "abc123");
  });

  test("renders empty date cell for attendee without date on daily listing", () => {
    const dailyListing = testListingWithCount({
      attendee_count: 1,
      listing_type: "daily",
    });
    const attendees = [testAttendee({ date: null })];
    const html = renderListingDetail({
      allowedDomain: "localhost",
      attendees,
      listing: dailyListing,
    });
    assertStringIncludes(html, "<th>Date</th>");
  });

  test("shows unlimited booking window when maximum_days_after is 0", () => {
    const dailyListing = testListingWithCount({
      listing_type: "daily",
      maximum_days_after: 0,
    });
    const html = renderListingDetail({
      allowedDomain: "localhost",
      attendees: [],
      listing: dailyListing,
    });
    assertStringIncludes(html, "unlimited");
  });

  test("shows numeric booking window when maximum_days_after is nonzero", () => {
    const dailyListing = testListingWithCount({
      listing_type: "daily",
      maximum_days_after: 30,
    });
    const html = renderListingDetail({
      allowedDomain: "localhost",
      attendees: [],
      listing: dailyListing,
    });
    assertStringIncludes(html, "to 30 days");
    assert(
      !html.includes("unlimited"),
      "the value should not contain the searched item",
    );
  });

  test("shows danger-text for daily listing at capacity with date filter", () => {
    const dailyListing = testListingWithCount({
      attendee_count: 0,
      listing_type: "daily",
      max_attendees: 2,
    });
    const attendees = [testAttendee(), testAttendee({ id: 2, name: "Jane" })];
    const html = renderListingDetail({
      allowedDomain: "localhost",
      attendees,
      dateFilter: "2026-03-15",
      listing: dailyListing,
    });
    assertStringIncludes(html, 'class="danger-text"');
    assertStringIncludes(html, "0 remain");
  });

  test("shows danger-text on the total count for a near-capacity daily listing without a date filter", () => {
    const dailyListing = testListingWithCount({
      attendee_count: 91,
      listing_type: "daily",
      max_attendees: 100,
    });
    const html = renderListingDetail({
      allowedDomain: "localhost",
      attendees: [],
      listing: dailyListing,
    });
    assertStringIncludes(html, 'class="danger-text">91<');
  });
});

describe("adminListingPage optional fields", () => {
  registerListingTemplateHooks();

  test("hides thank you URL row when no thank_you_url", () => {
    const listing = testListingWithCount({
      attendee_count: 0,
      thank_you_url: "",
    });
    const html = renderListingDetail({
      allowedDomain: "localhost",
      attendees: [],
      listing,
    });
    assert(
      !html.includes("Thank You URL"),
      "the value should not contain the searched item",
    );
  });

  test("shows webhook URL in copyable input when present", () => {
    const listing = testListingWithCount({
      attendee_count: 0,
      webhook_url: "https://hooks.example.com/notify",
    });
    const html = renderListingDetail({
      allowedDomain: "localhost",
      attendees: [],
      listing,
    });
    assertStringIncludes(html, "Webhook URL");
    assertStringIncludes(html, 'value="https://hooks.example.com/notify"');
    assertStringIncludes(html, "readonly");
  });

  test("hides embed rows for a child listing", () => {
    const listing = testListingWithCount({ attendee_count: 0 });
    const html = renderListingDetail({
      allowedDomain: "localhost",
      attendees: [],
      listing,
      publicPage: "child",
    });
    assert(
      !html.includes(`embed-script-${listing.id}`),
      "the value should not contain the searched item",
    );
    assert(
      !html.includes(`embed-iframe-${listing.id}`),
      "the value should not contain the searched item",
    );
  });
});

describe("adminListingPage listing date and location", () => {
  registerListingTemplateHooks();

  test("shows Listing Date row when listing has a date", () => {
    const listing = testListingWithCount({
      attendee_count: 0,
      date: "2026-06-15T14:00:00.000Z",
    });
    const html = renderListingDetail({
      allowedDomain: "localhost",
      attendees: [],
      listing,
    });
    assertStringIncludes(html, "Listing Date");
    assertStringIncludes(html, "Monday 15 June 2026 at 15:00 GMT+1");
  });

  test("does not show Listing Date row when date is empty", () => {
    const listing = testListingWithCount({ attendee_count: 0, date: "" });
    const html = renderListingDetail({
      allowedDomain: "localhost",
      attendees: [],
      listing,
    });
    assert(
      !html.includes("Listing Date"),
      "the value should not contain the searched item",
    );
  });

  test("shows Location row when listing has a location", () => {
    const listing = testListingWithCount({
      attendee_count: 0,
      location: "Village Hall",
    });
    const html = renderListingDetail({
      allowedDomain: "localhost",
      attendees: [],
      listing,
    });
    assertStringIncludes(html, "<th>Location</th>");
    assertStringIncludes(html, "Village Hall");
  });

  test("does not show Location row when location is empty", () => {
    const listing = testListingWithCount({ attendee_count: 0, location: "" });
    const html = renderListingDetail({
      allowedDomain: "localhost",
      attendees: [],
      listing,
    });
    assert(
      !html.includes("<th>Location</th>"),
      "the value should not contain the searched item",
    );
  });

  test("shows both Listing Date and Location when both are set", () => {
    const listing = testListingWithCount({
      attendee_count: 0,
      date: "2026-06-15T14:00:00.000Z",
      location: "Town Centre",
    });
    const html = renderListingDetail({
      allowedDomain: "localhost",
      attendees: [],
      listing,
    });
    assertStringIncludes(html, "Listing Date");
    assertStringIncludes(html, "Town Centre");
  });
});
