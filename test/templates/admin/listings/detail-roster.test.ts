import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { ListingDeactivatedBanner } from "#templates/admin/listings/overview.tsx";
import { testAttendee, testListingWithCount } from "#test-utils/factories.ts";

import {
  registerListingTemplateHooks,
  renderListingDetail,
} from "./helpers.ts";

registerListingTemplateHooks();

describe("adminListingPage roster and attendees", () => {
  const listing = testListingWithCount({ attendee_count: 2 });

  test("shows thank you URL in copyable input", () => {
    const html = renderListingDetail({
      allowedDomain: "localhost",
      attendees: [],
      listing,
    });
    expect(html).toContain("Thank You URL");
    expect(html).toContain('value="https://example.com/thanks"');
    expect(html).toContain("readonly");
    expect(html).toContain("data-select-on-click");
  });

  test("shows public URL with allowed domain", () => {
    const html = renderListingDetail({
      allowedDomain: "example.com",
      attendees: [],
      listing,
    });
    expect(html).toContain("Public URL");
    expect(html).toContain('href="https://example.com/ticket/ab12c"');
    expect(html).toContain("example.com/ticket/ab12c");
  });

  test("shows collapsed embed codes with allowed domain and iframe param", () => {
    const html = renderListingDetail({
      allowedDomain: "example.com",
      attendees: [],
      listing,
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
    const html = renderListingDetail({
      allowedDomain: "example.com",
      attendees: [],
      listing,
    });
    expect(html).not.toContain("iframeResize");
  });

  test("renders empty attendees state", () => {
    const html = renderListingDetail({
      allowedDomain: "localhost",
      attendees: [],
      listing,
    });
    expect(html).toContain("No attendees yet");
  });

  test("renders attendees table", () => {
    const attendees = [testAttendee()];
    const html = renderListingDetail({
      allowedDomain: "localhost",
      attendees,
      listing,
    });
    expect(html).toContain("John Doe");
    expect(html).toContain("john@example.com");
  });

  test("escapes attendee data", () => {
    const attendees = [testAttendee({ name: "<script>evil()</script>" })];
    const html = renderListingDetail({
      allowedDomain: "localhost",
      attendees,
      listing,
    });
    expect(html).toContain("&lt;script&gt;");
  });

  test("includes back link", () => {
    const html = renderListingDetail({
      allowedDomain: "localhost",
      attendees: [],
      listing,
    });
    expect(html).toContain("/admin/");
  });

  test("shows phone column when attendee has phone", () => {
    const attendees = [testAttendee({ phone: "+1 555 123 4567" })];
    const html = renderListingDetail({
      allowedDomain: "localhost",
      attendees,
      listing,
    });
    expect(html).toContain("<th>Phone</th>");
    expect(html).toContain("+1 555 123 4567");
  });

  test("hides phone column when no attendees have phone", () => {
    const attendees = [testAttendee({ phone: "" })];
    const html = renderListingDetail({
      allowedDomain: "localhost",
      attendees,
      listing,
    });
    expect(html).not.toContain("<th>Phone</th>");
  });

  test("hides email column when no attendees have email", () => {
    const attendees = [testAttendee({ email: "" })];
    const html = renderListingDetail({
      allowedDomain: "localhost",
      attendees,
      listing,
    });
    expect(html).toContain("John Doe");
    expect(html).not.toContain("<th>Email</th>");
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
    expect(html).toContain('class="danger-text"');
    expect(html).toContain("9 remain");
  });

  test("does not show danger-text class when not near capacity", () => {
    const html = renderListingDetail({
      allowedDomain: "localhost",
      attendees: [],
      listing,
    });
    expect(html).not.toContain('class="danger-text"');
  });

  test("shows deactivated alert for inactive listings", () => {
    const html = String(ListingDeactivatedBanner({ active: false }));
    expect(html).toContain('class="error"');
    expect(html).toContain("This listing is deactivated and cannot be booked");
  });

  test("does not show deactivated alert for active listings", () => {
    const html = String(ListingDeactivatedBanner({ active: true }));
    expect(html).not.toContain(
      "This listing is deactivated and cannot be booked",
    );
  });

  test("shows ticket column header", () => {
    const html = renderListingDetail({
      allowedDomain: "localhost",
      attendees: [],
      listing,
    });
    expect(html).toContain("<th>Ticket</th>");
  });

  test("shows ticket token as link to public ticket URL", () => {
    const attendees = [testAttendee({ ticket_token: "abc123" })];
    const html = renderListingDetail({
      allowedDomain: "mysite.com",
      attendees,
      listing,
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
    const html = renderListingDetail({
      allowedDomain: "localhost",
      attendees,
      listing: dailyListing,
    });
    expect(html).toContain("<th>Date</th>");
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
    expect(html).toContain("unlimited");
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
    const html = renderListingDetail({
      allowedDomain: "localhost",
      attendees,
      dateFilter: "2026-03-15",
      listing: dailyListing,
    });
    expect(html).toContain('class="danger-text"');
    expect(html).toContain("0 remain");
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
    expect(html).toContain('class="danger-text">91<');
  });
});

describe("adminListingPage optional fields", () => {
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
    expect(html).not.toContain("Thank You URL");
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
    expect(html).toContain("Webhook URL");
    expect(html).toContain('value="https://hooks.example.com/notify"');
    expect(html).toContain("readonly");
  });
});

describe("adminListingPage listing date and location", () => {
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
    expect(html).toContain("Listing Date");
    expect(html).toContain("Monday 15 June 2026 at 15:00 GMT+1");
  });

  test("does not show Listing Date row when date is empty", () => {
    const listing = testListingWithCount({ attendee_count: 0, date: "" });
    const html = renderListingDetail({
      allowedDomain: "localhost",
      attendees: [],
      listing,
    });
    expect(html).not.toContain("Listing Date");
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
    expect(html).toContain("<th>Location</th>");
    expect(html).toContain("Village Hall");
  });

  test("does not show Location row when location is empty", () => {
    const listing = testListingWithCount({ attendee_count: 0, location: "" });
    const html = renderListingDetail({
      allowedDomain: "localhost",
      attendees: [],
      listing,
    });
    expect(html).not.toContain("<th>Location</th>");
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
    expect(html).toContain("Listing Date");
    expect(html).toContain("Town Centre");
  });
});
