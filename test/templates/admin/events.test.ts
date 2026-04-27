import { expect } from "@std/expect";
import { afterEach, beforeAll, describe, it as test } from "@std/testing/bdd";
import { signCsrfToken } from "#shared/csrf.ts";
import { detectIframeMode } from "#shared/iframe.ts";
import { runWithStorageConfig } from "#shared/storage.ts";
import {
  adminDuplicateEventPage,
  adminEventEditPage,
  adminEventNewPage,
  adminEventPage,
  isIncompletePayment,
  nearCapacity,
} from "#templates/admin/events.tsx";
import { eventFields } from "#templates/fields.ts";
import {
  describeWithEnv,
  hasSelectedOption,
  setupTestEncryptionKey,
  testAttendee,
  testEventWithCount,
  testGroup,
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

describe("adminEventEditPage group select", () => {
  test("preselects the event group_id when groups exist", () => {
    const groups = [testGroup({ id: 2, name: "Group Two" })];
    const event = testEventWithCount({ group_id: 2 });
    const html = adminEventEditPage(event, groups, TEST_SESSION);
    expect(html).toContain('name="group_id"');
    expect(hasSelectedOption(html, "2")).toBe(true);
    expect(hasSelectedOption(html, "0")).toBe(false);
  });
});

describe("adminEventPage", () => {
  const event = testEventWithCount({ attendee_count: 2 });

  test("renders event name", () => {
    const html = adminEventPage({
      allowedDomain: "localhost",
      attendees: [],
      event,
      session: TEST_SESSION,
    });
    expect(html).toContain("Test Event");
  });

  test("shows attendees row with count and remaining", () => {
    const html = adminEventPage({
      allowedDomain: "localhost",
      attendees: [],
      event,
      session: TEST_SESSION,
    });
    expect(html).toContain("Attendees");
    expect(html).toContain("2 / 100");
    expect(html).toContain("98 remain");
  });

  test("shows checked in row with 0 of 0 when no attendees", () => {
    const html = adminEventPage({
      allowedDomain: "localhost",
      attendees: [],
      event,
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
    const html = adminEventPage({
      allowedDomain: "localhost",
      attendees,
      event,
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
    const html = adminEventPage({
      allowedDomain: "localhost",
      attendees,
      event,
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

  test("dual checked-in rows show daily suffix when daily event with dateFilter", () => {
    const dailyEvent = testEventWithCount({
      attendee_count: 5,
      event_type: "daily",
    });
    const attendees = [
      testAttendee({ checked_in: true, id: 1, quantity: 2 }),
      testAttendee({ checked_in: false, id: 2, quantity: 3 }),
    ];
    const html = adminEventPage({
      allowedDomain: "localhost",
      attendees,
      dateFilter: "2026-03-15",
      event: dailyEvent,
      session: TEST_SESSION,
    });
    expect(html).toContain("Attendees Checked In (Sunday 15 March 2026)");
    expect(html).toContain("Tickets Checked In (Sunday 15 March 2026)");
  });

  test("dual checked-in rows show total suffix when daily event without dateFilter", () => {
    const dailyEvent = testEventWithCount({
      attendee_count: 5,
      event_type: "daily",
    });
    const attendees = [
      testAttendee({ checked_in: true, id: 1, quantity: 2 }),
      testAttendee({ checked_in: false, id: 2, quantity: 3 }),
    ];
    const html = adminEventPage({
      allowedDomain: "localhost",
      attendees,
      event: dailyEvent,
      session: TEST_SESSION,
    });
    expect(html).toContain("Attendees Checked In (total)");
    expect(html).toContain("Tickets Checked In (total)");
  });

  test("shows thank you URL in copyable input", () => {
    const html = adminEventPage({
      allowedDomain: "localhost",
      attendees: [],
      event,
      session: TEST_SESSION,
    });
    expect(html).toContain("Thank You URL");
    expect(html).toContain('value="https://example.com/thanks"');
    expect(html).toContain("readonly");
    expect(html).toContain("data-select-on-click");
  });

  test("shows public URL with allowed domain", () => {
    const html = adminEventPage({
      allowedDomain: "example.com",
      attendees: [],
      event,
      session: TEST_SESSION,
    });
    expect(html).toContain("Public URL");
    expect(html).toContain('href="https://example.com/ticket/ab12c"');
    expect(html).toContain("example.com/ticket/ab12c");
  });

  test("shows embed codes with allowed domain and iframe param", () => {
    const html = adminEventPage({
      allowedDomain: "example.com",
      attendees: [],
      event,
      session: TEST_SESSION,
    });
    expect(html).toContain("Embed Script");
    expect(html).toContain("Embed Iframe");
    expect(html).toContain("embed.js");
    expect(html).toContain("data-events=");
    expect(html).toContain("https://example.com/ticket/ab12c?iframe=true");
    expect(html).toContain("height: 600px");
    expect(html).toContain("loading=");
    expect(html).toContain("readonly");
  });

  test("iframe embed is a plain iframe without resizer scripts", () => {
    const html = adminEventPage({
      allowedDomain: "example.com",
      attendees: [],
      event,
      session: TEST_SESSION,
    });
    expect(html).not.toContain("iframeResize");
  });

  test("renders empty attendees state", () => {
    const html = adminEventPage({
      allowedDomain: "localhost",
      attendees: [],
      event,
      session: TEST_SESSION,
    });
    expect(html).toContain("No attendees yet");
  });

  test("renders attendees table", () => {
    const attendees = [testAttendee()];
    const html = adminEventPage({
      allowedDomain: "localhost",
      attendees,
      event,
      session: TEST_SESSION,
    });
    expect(html).toContain("John Doe");
    expect(html).toContain("john@example.com");
  });

  test("escapes attendee data", () => {
    const attendees = [testAttendee({ name: "<script>evil()</script>" })];
    const html = adminEventPage({
      allowedDomain: "localhost",
      attendees,
      event,
      session: TEST_SESSION,
    });
    expect(html).toContain("&lt;script&gt;");
  });

  test("includes back link", () => {
    const html = adminEventPage({
      allowedDomain: "localhost",
      attendees: [],
      event,
      session: TEST_SESSION,
    });
    expect(html).toContain("/admin/");
  });

  test("shows phone column when attendee has phone", () => {
    const attendees = [testAttendee({ phone: "+1 555 123 4567" })];
    const html = adminEventPage({
      allowedDomain: "localhost",
      attendees,
      event,
      session: TEST_SESSION,
    });
    expect(html).toContain("<th>Phone</th>");
    expect(html).toContain("+1 555 123 4567");
  });

  test("hides phone column when no attendees have phone", () => {
    const attendees = [testAttendee({ phone: "" })];
    const html = adminEventPage({
      allowedDomain: "localhost",
      attendees,
      event,
      session: TEST_SESSION,
    });
    expect(html).not.toContain("<th>Phone</th>");
  });

  test("hides email column when no attendees have email", () => {
    const attendees = [testAttendee({ email: "" })];
    const html = adminEventPage({
      allowedDomain: "localhost",
      attendees,
      event,
      session: TEST_SESSION,
    });
    expect(html).toContain("John Doe");
    expect(html).not.toContain("<th>Email</th>");
  });

  test("shows danger-text class when near capacity", () => {
    const nearFullEvent = testEventWithCount({
      attendee_count: 91,
      max_attendees: 100,
    });
    const html = adminEventPage({
      allowedDomain: "localhost",
      attendees: [],
      event: nearFullEvent,
      session: TEST_SESSION,
    });
    expect(html).toContain('class="danger-text"');
    expect(html).toContain("9 remain");
  });

  test("does not show danger-text class when not near capacity", () => {
    const html = adminEventPage({
      allowedDomain: "localhost",
      attendees: [],
      event,
      session: TEST_SESSION,
    });
    expect(html).not.toContain('class="danger-text"');
  });

  test("shows deactivated alert for inactive events", () => {
    const inactive = testEventWithCount({ active: false, attendee_count: 0 });
    const html = adminEventPage({
      allowedDomain: "localhost",
      attendees: [],
      event: inactive,
      session: TEST_SESSION,
    });
    expect(html).toContain('class="error"');
    expect(html).toContain("This event is deactivated and cannot be booked");
  });

  test("does not show deactivated alert for active events", () => {
    const html = adminEventPage({
      allowedDomain: "localhost",
      attendees: [],
      event,
      session: TEST_SESSION,
    });
    expect(html).not.toContain(
      "This event is deactivated and cannot be booked",
    );
  });

  test("shows ticket column header", () => {
    const html = adminEventPage({
      allowedDomain: "localhost",
      attendees: [],
      event,
      session: TEST_SESSION,
    });
    expect(html).toContain("<th>Ticket</th>");
  });

  test("shows ticket token as link to public ticket URL", () => {
    const attendees = [testAttendee({ ticket_token: "abc123" })];
    const html = adminEventPage({
      allowedDomain: "mysite.com",
      attendees,
      event,
      session: TEST_SESSION,
    });
    expect(html).toContain('href="https://mysite.com/t/abc123"');
    expect(html).toContain("abc123");
  });

  test("renders empty date cell for attendee without date on daily event", () => {
    const dailyEvent = testEventWithCount({
      attendee_count: 1,
      event_type: "daily",
    });
    const attendees = [testAttendee({ date: null })];
    const html = adminEventPage({
      allowedDomain: "localhost",
      attendees,
      event: dailyEvent,
      session: TEST_SESSION,
    });
    expect(html).toContain("<th>Date</th>");
  });

  test("shows unlimited booking window when maximum_days_after is 0", () => {
    const dailyEvent = testEventWithCount({
      event_type: "daily",
      maximum_days_after: 0,
    });
    const html = adminEventPage({
      allowedDomain: "localhost",
      attendees: [],
      event: dailyEvent,
      session: TEST_SESSION,
    });
    expect(html).toContain("unlimited");
  });

  test("shows numeric booking window when maximum_days_after is nonzero", () => {
    const dailyEvent = testEventWithCount({
      event_type: "daily",
      maximum_days_after: 30,
    });
    const html = adminEventPage({
      allowedDomain: "localhost",
      attendees: [],
      event: dailyEvent,
      session: TEST_SESSION,
    });
    expect(html).toContain("to 30 days");
    expect(html).not.toContain("unlimited");
  });

  test("shows danger-text for daily event at capacity with date filter", () => {
    const dailyEvent = testEventWithCount({
      attendee_count: 0,
      event_type: "daily",
      max_attendees: 2,
    });
    const attendees = [testAttendee(), testAttendee({ id: 2, name: "Jane" })];
    const html = adminEventPage({
      allowedDomain: "localhost",
      attendees,
      dateFilter: "2026-03-15",
      event: dailyEvent,
      session: TEST_SESSION,
    });
    expect(html).toContain('class="danger-text"');
    expect(html).toContain("0 remain");
  });
});

describe("adminEventNewPage", () => {
  test("renders create event form fields", () => {
    const html = adminEventNewPage([], TEST_SESSION);
    expect(html).toContain("Add Event");
    expect(html).toContain('name="name"');
    expect(html).toContain('name="max_attendees"');
    expect(html).toContain('name="thank_you_url"');
    expect(html).toContain('name="unit_price"');
    expect(html).toContain("Ticket Price");
  });

  test("renders breadcrumb back link", () => {
    const html = adminEventNewPage([], TEST_SESSION);
    expect(html).toContain('href="/admin/"');
    expect(html).toContain("Events");
  });

  test("renders group select when groups exist", () => {
    const groups = [testGroup({ id: 2, name: "My Group" })];
    const html = adminEventNewPage(groups, TEST_SESSION);
    expect(html).toContain('name="group_id"');
    expect(hasSelectedOption(html, "0")).toBe(true);
    expect(html).toContain('value="2"');
    expect(html).toContain("My Group");
  });

  test("renders error when provided", () => {
    const html = adminEventNewPage([], TEST_SESSION, "Something went wrong");
    expect(html).toContain("Something went wrong");
  });
});

describe("adminEventPage export button", () => {
  test("renders export CSV button", () => {
    const event = testEventWithCount({ attendee_count: 2 });
    const html = adminEventPage({
      allowedDomain: "localhost",
      attendees: [],
      event,
      session: TEST_SESSION,
    });
    expect(html).toContain("/admin/event/1/export");
    expect(html).toContain("Export CSV");
  });
});

describe("adminEventPage filter links", () => {
  test("renders All / Checked In / Checked Out links", () => {
    const event = testEventWithCount({ attendee_count: 1 });
    const attendees = [testAttendee()];
    const html = adminEventPage({
      allowedDomain: "localhost",
      attendees,
      event,
      session: TEST_SESSION,
    });
    expect(html).toContain("All");
    expect(html).toContain("Checked In");
    expect(html).toContain("Checked Out");
  });

  test("bolds All when no filter is active", () => {
    const event = testEventWithCount({ attendee_count: 1 });
    const attendees = [testAttendee()];
    const html = adminEventPage({
      allowedDomain: "localhost",
      attendees,
      event,
      session: TEST_SESSION,
    });
    expect(html).toContain("<strong>All</strong>");
    expect(html).toContain(`href="/admin/event/${event.id}/in#attendees"`);
    expect(html).toContain(`href="/admin/event/${event.id}/out#attendees"`);
  });

  test("bolds Checked In when filter is in", () => {
    const event = testEventWithCount({ attendee_count: 1 });
    const attendees = [testAttendee()];
    const html = adminEventPage({
      activeFilter: "in",
      allowedDomain: "localhost",
      attendees,
      event,
      session: TEST_SESSION,
    });
    expect(html).toContain("<strong>Checked In</strong>");
    expect(html).toContain(`href="/admin/event/${event.id}#attendees"`);
  });

  test("bolds Checked Out when filter is out", () => {
    const event = testEventWithCount({ attendee_count: 1 });
    const attendees = [testAttendee()];
    const html = adminEventPage({
      activeFilter: "out",
      allowedDomain: "localhost",
      attendees,
      event,
      session: TEST_SESSION,
    });
    expect(html).toContain("<strong>Checked Out</strong>");
  });

  test("filters to only checked-in attendees when filter is in", () => {
    const event = testEventWithCount({ attendee_count: 2 });
    const attendees = [
      testAttendee({ checked_in: true, id: 1, name: "Checked In User" }),
      testAttendee({ checked_in: false, id: 2, name: "Not Checked In User" }),
    ];
    const html = adminEventPage({
      activeFilter: "in",
      allowedDomain: "localhost",
      attendees,
      event,
      session: TEST_SESSION,
    });
    expect(html).toContain("Checked In User");
    expect(html).not.toContain("Not Checked In User");
  });

  test("filters to only checked-out attendees when filter is out", () => {
    const event = testEventWithCount({ attendee_count: 2 });
    const attendees = [
      testAttendee({ checked_in: true, id: 1, name: "Alice InPerson" }),
      testAttendee({ checked_in: false, id: 2, name: "Bob Remote" }),
    ];
    const html = adminEventPage({
      activeFilter: "out",
      allowedDomain: "localhost",
      attendees,
      event,
      session: TEST_SESSION,
    });
    expect(html).not.toContain("Alice InPerson");
    expect(html).toContain("Bob Remote");
  });

  test("shows all attendees when filter is all", () => {
    const event = testEventWithCount({ attendee_count: 2 });
    const attendees = [
      testAttendee({ checked_in: true, id: 1, name: "Checked In User" }),
      testAttendee({ checked_in: false, id: 2, name: "Not Checked In User" }),
    ];
    const html = adminEventPage({
      activeFilter: "all",
      allowedDomain: "localhost",
      attendees,
      event,
      session: TEST_SESSION,
    });
    expect(html).toContain("Checked In User");
    expect(html).toContain("Not Checked In User");
  });

  test("includes return_filter hidden field in checkin form", () => {
    const event = testEventWithCount({ attendee_count: 1 });
    const attendees = [testAttendee({ checked_in: true })];
    const html = adminEventPage({
      activeFilter: "in",
      allowedDomain: "localhost",
      attendees,
      event,
      session: TEST_SESSION,
    });
    expect(html).toContain('name="return_filter"');
    expect(html).toContain('value="in"');
  });
});

describe("adminEventPage total revenue", () => {
  test("shows total revenue for paid events", () => {
    const event = testEventWithCount({ attendee_count: 2, unit_price: 1000 });
    const attendees = [
      testAttendee({ payment_id: "pi_test_1", price_paid: "1000" }),
      testAttendee({ id: 2, payment_id: "pi_test_2", price_paid: "2000" }),
    ];
    const html = adminEventPage({
      allowedDomain: "localhost",
      attendees,
      event,
      session: TEST_SESSION,
    });
    expect(html).toContain("Total Revenue");
    expect(html).toContain("£30");
  });

  test("does not show total revenue for free events", () => {
    const event = testEventWithCount({ attendee_count: 1, unit_price: 0 });
    const attendees = [testAttendee()];
    const html = adminEventPage({
      allowedDomain: "localhost",
      attendees,
      event,
      session: TEST_SESSION,
    });
    expect(html).not.toContain("Total Revenue");
  });

  test("shows zero revenue for paid event with no attendees", () => {
    const event = testEventWithCount({ attendee_count: 0, unit_price: 1000 });
    const html = adminEventPage({
      allowedDomain: "localhost",
      attendees: [],
      event,
      session: TEST_SESSION,
    });
    expect(html).toContain("Total Revenue");
    expect(html).toContain("£0");
  });
});

describe("adminEventPage optional fields", () => {
  test("shows reactivate link for inactive events", () => {
    const event = testEventWithCount({ active: false, attendee_count: 0 });
    const html = adminEventPage({
      allowedDomain: "localhost",
      attendees: [],
      event,
      session: TEST_SESSION,
    });
    expect(html).toContain("/reactivate");
    expect(html).toContain("Reactivate");
  });

  test("hides thank you URL row when no thank_you_url", () => {
    const event = testEventWithCount({
      attendee_count: 0,
      thank_you_url: "",
    });
    const html = adminEventPage({
      allowedDomain: "localhost",
      attendees: [],
      event,
      session: TEST_SESSION,
    });
    expect(html).not.toContain("Thank You URL");
  });

  test("shows webhook URL in copyable input when present", () => {
    const event = testEventWithCount({
      attendee_count: 0,
      webhook_url: "https://hooks.example.com/notify",
    });
    const html = adminEventPage({
      allowedDomain: "localhost",
      attendees: [],
      event,
      session: TEST_SESSION,
    });
    expect(html).toContain("Webhook URL");
    expect(html).toContain('value="https://hooks.example.com/notify"');
    expect(html).toContain("readonly");
  });
});

describe("nearCapacity", () => {
  test("returns true when at 90% capacity", () => {
    const event = testEventWithCount({
      attendee_count: 90,
      max_attendees: 100,
    });
    expect(nearCapacity(event)).toBe(true);
  });

  test("returns true when over 90% capacity", () => {
    const event = testEventWithCount({
      attendee_count: 95,
      max_attendees: 100,
    });
    expect(nearCapacity(event)).toBe(true);
  });

  test("returns false when under 90% capacity", () => {
    const event = testEventWithCount({
      attendee_count: 89,
      max_attendees: 100,
    });
    expect(nearCapacity(event)).toBe(false);
  });

  test("returns true when fully sold out", () => {
    const event = testEventWithCount({
      attendee_count: 100,
      max_attendees: 100,
    });
    expect(nearCapacity(event)).toBe(true);
  });
});

describe("isIncompletePayment", () => {
  test("returns true for paid event attendee with no payment_id and price > 0", () => {
    const attendee = testAttendee({ payment_id: "", price_paid: "1000" });
    expect(isIncompletePayment(attendee, true)).toBe(true);
  });

  test("returns false for free event", () => {
    const attendee = testAttendee({ payment_id: "", price_paid: "0" });
    expect(isIncompletePayment(attendee, false)).toBe(false);
  });

  test("returns false for admin-added attendee on paid event (price_paid=0)", () => {
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

describe("adminEventPage failed payments", () => {
  test("shows Failed Payments section when incomplete attendees exist", () => {
    const event = testEventWithCount({ attendee_count: 3, unit_price: 1000 });
    const attendees = [
      testAttendee({ id: 1, payment_id: "pi_ok", price_paid: "1000" }),
      testAttendee({ id: 2, payment_id: "", price_paid: "1000" }),
    ];
    const html = adminEventPage({
      allowedDomain: "localhost",
      attendees,
      event,
      session: TEST_SESSION,
    });
    expect(html).toContain("Failed Payments");
    expect(html).toContain("1 attendee(s) with unresolved payments");
    expect(html).toContain("/delete-incomplete");
  });

  test("hides Failed Payments section when no incomplete attendees", () => {
    const event = testEventWithCount({ attendee_count: 1, unit_price: 1000 });
    const attendees = [
      testAttendee({ id: 1, payment_id: "pi_ok", price_paid: "1000" }),
    ];
    const html = adminEventPage({
      allowedDomain: "localhost",
      attendees,
      event,
      session: TEST_SESSION,
    });
    expect(html).not.toContain("Failed Payments");
  });

  test("hides Failed Payments section for free events", () => {
    const event = testEventWithCount({ attendee_count: 1, unit_price: 0 });
    const attendees = [testAttendee({ id: 1, price_paid: "0" })];
    const html = adminEventPage({
      allowedDomain: "localhost",
      attendees,
      event,
      session: TEST_SESSION,
    });
    expect(html).not.toContain("Failed Payments");
  });

  test("excludes incomplete attendees from attendee count", () => {
    const event = testEventWithCount({
      attendee_count: 3,
      max_attendees: 100,
      unit_price: 1000,
    });
    const attendees = [
      testAttendee({ id: 1, payment_id: "pi_ok", price_paid: "1000" }),
      testAttendee({ id: 2, payment_id: "", price_paid: "1000" }),
    ];
    const html = adminEventPage({
      allowedDomain: "localhost",
      attendees,
      event,
      session: TEST_SESSION,
    });
    // adjusted count: 3 - 1 (incomplete qty) = 2
    expect(html).toContain("2 / 100");
  });

  test("excludes incomplete attendees from checked-in count", () => {
    const event = testEventWithCount({ attendee_count: 2, unit_price: 1000 });
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
    const html = adminEventPage({
      allowedDomain: "localhost",
      attendees,
      event,
      session: TEST_SESSION,
    });
    // Only complete attendees count: 1 checked in / 1 total
    expect(html).toContain("1 / 1");
  });

  test("excludes incomplete attendees from revenue", () => {
    const event = testEventWithCount({ attendee_count: 2, unit_price: 1000 });
    const attendees = [
      testAttendee({ id: 1, payment_id: "pi_ok", price_paid: "1000" }),
      testAttendee({ id: 2, payment_id: "", price_paid: "2000" }),
    ];
    const html = adminEventPage({
      allowedDomain: "localhost",
      attendees,
      event,
      session: TEST_SESSION,
    });
    expect(html).toContain("£10");
    expect(html).not.toContain("£30");
  });

  test("failed payments table has delete button but no check-in or refund", () => {
    const event = testEventWithCount({ attendee_count: 1, unit_price: 1000 });
    const attendees = [
      testAttendee({
        id: 1,
        name: "Jane Stuck",
        payment_id: "",
        price_paid: "1000",
      }),
    ];
    const html = adminEventPage({
      allowedDomain: "localhost",
      attendees,
      event,
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

describe("adminEventPage event date and location", () => {
  test("shows Event Date row when event has a date", () => {
    const event = testEventWithCount({
      attendee_count: 0,
      date: "2026-06-15T14:00:00.000Z",
    });
    const html = adminEventPage({
      allowedDomain: "localhost",
      attendees: [],
      event,
      session: TEST_SESSION,
    });
    expect(html).toContain("Event Date");
    expect(html).toContain("Monday 15 June 2026 at 15:00 GMT+1");
  });

  test("does not show Event Date row when date is empty", () => {
    const event = testEventWithCount({ attendee_count: 0, date: "" });
    const html = adminEventPage({
      allowedDomain: "localhost",
      attendees: [],
      event,
      session: TEST_SESSION,
    });
    expect(html).not.toContain("Event Date");
  });

  test("shows Location row when event has a location", () => {
    const event = testEventWithCount({
      attendee_count: 0,
      location: "Village Hall",
    });
    const html = adminEventPage({
      allowedDomain: "localhost",
      attendees: [],
      event,
      session: TEST_SESSION,
    });
    expect(html).toContain("<th>Location</th>");
    expect(html).toContain("Village Hall");
  });

  test("does not show Location row when location is empty", () => {
    const event = testEventWithCount({ attendee_count: 0, location: "" });
    const html = adminEventPage({
      allowedDomain: "localhost",
      attendees: [],
      event,
      session: TEST_SESSION,
    });
    expect(html).not.toContain("<th>Location</th>");
  });

  test("shows both Event Date and Location when both are set", () => {
    const event = testEventWithCount({
      attendee_count: 0,
      date: "2026-06-15T14:00:00.000Z",
      location: "Town Centre",
    });
    const html = adminEventPage({
      allowedDomain: "localhost",
      attendees: [],
      event,
      session: TEST_SESSION,
    });
    expect(html).toContain("Event Date");
    expect(html).toContain("Town Centre");
  });
});

describe("adminEventPage edit form pre-fills date and location", () => {
  test("empty date shows no pre-filled value in edit form", () => {
    const event = testEventWithCount({ attendee_count: 0, date: "" });
    const html = adminEventEditPage(event, [], TEST_SESSION, undefined);
    // The date field should render split date and time inputs
    expect(html).toContain('name="date_date"');
    expect(html).toContain('name="date_time"');
  });

  test("non-empty date shows formatted split values in edit form", () => {
    const event = testEventWithCount({
      attendee_count: 0,
      date: "2026-06-15T14:00:00.000Z",
    });
    const html = adminEventEditPage(event, [], TEST_SESSION, undefined);
    // Should contain split date and time values converted to Europe/London (BST = UTC+1)
    expect(html).toContain('value="2026-06-15"');
    expect(html).toContain('value="15:00"');
  });

  test("pre-fills location in edit form", () => {
    const event = testEventWithCount({
      attendee_count: 0,
      location: "Village Hall",
    });
    const html = adminEventEditPage(event, [], TEST_SESSION, undefined);
    expect(html).toContain('value="Village Hall"');
  });
});

describe("adminEventEditPage max_price field", () => {
  test("renders max_price field with value when set", () => {
    const event = testEventWithCount({
      attendee_count: 0,
      can_pay_more: true,
      max_price: 50000,
    });
    const html = adminEventEditPage(event, [], TEST_SESSION, undefined);
    expect(html).toContain('name="max_price"');
    expect(html).toContain('value="500.00"');
  });

  test("renders max_price field with 0.00 when zero", () => {
    const event = testEventWithCount({
      attendee_count: 0,
      can_pay_more: true,
      max_price: 0,
    });
    const html = adminEventEditPage(event, [], TEST_SESSION, undefined);
    expect(html).toContain('name="max_price"');
    expect(html).toContain('value="0.00"');
  });
});

describe("datetime validation via eventFields date field", () => {
  const dateField = eventFields.find((f) => f.name === "date")!;

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
  "event images",
  { env: { STORAGE_ZONE_KEY: "testkey", STORAGE_ZONE_NAME: "testzone" } },
  () => {
    describe("adminEventPage image section", () => {
      test("does not show image upload on detail page", () => {
        const event = testEventWithCount({ image_url: "" });
        const html = adminEventPage({
          allowedDomain: "localhost",
          attendees: [],
          event,
          session: TEST_SESSION,
        });
        expect(html).not.toContain('type="file"');
        expect(html).not.toContain('name="image"');
      });
    });

    describe("adminEventEditPage image section", () => {
      test("shows image upload field when storage enabled", () => {
        const event = testEventWithCount({ image_url: "" });
        const html = adminEventEditPage(event, [], TEST_SESSION);
        expect(html).toContain('type="file"');
        expect(html).toContain('name="image"');
        expect(html).toContain("multipart/form-data");
      });

      test("shows current image and remove button when image is set", () => {
        runWithStorageConfig(
          { zoneKey: "testkey", zoneName: "testzone" },
          () => {
            const event = testEventWithCount({ image_url: "current.jpg" });
            const html = adminEventEditPage(event, [], TEST_SESSION);
            expect(html).toContain("/image/current.jpg");
            expect(html).toContain("Remove Image");
            expect(html).toContain("/image/delete");
          },
        );
      });

      test("does not show image field when storage is not enabled", () => {
        withStorageDisabled(() => {
          const event = testEventWithCount({ image_url: "" });
          const html = adminEventEditPage(event, [], TEST_SESSION);
          expect(html).not.toContain('type="file"');
          expect(html).not.toContain('name="image"');
        });
      });

      test("shows full-width image preview when event has image", () => {
        runWithStorageConfig(
          { zoneKey: "testkey", zoneName: "testzone" },
          () => {
            const event = testEventWithCount({ image_url: "preview.jpg" });
            const html = adminEventEditPage(event, [], TEST_SESSION);
            expect(html).toContain("event-image-full");
            expect(html).toContain("/image/preview.jpg");
          },
        );
      });
    });

    describe("adminDuplicateEventPage image section", () => {
      test("shows image upload field when storage enabled", () => {
        runWithStorageConfig(
          { zoneKey: "testkey", zoneName: "testzone" },
          () => {
            const event = testEventWithCount({ image_url: "" });
            const html = adminDuplicateEventPage(event, [], TEST_SESSION);
            expect(html).toContain('type="file"');
            expect(html).toContain('name="image"');
            expect(html).toContain("multipart/form-data");
          },
        );
      });

      test("does not show image field when storage is not enabled", () => {
        withStorageDisabled(() => {
          const event = testEventWithCount({ image_url: "" });
          const html = adminDuplicateEventPage(event, [], TEST_SESSION);
          expect(html).not.toContain('type="file"');
          expect(html).not.toContain('name="image"');
        });
      });
    });

    describe("adminEventNewPage image section", () => {
      test("shows image upload field on create form when storage enabled", () => {
        runWithStorageConfig(
          { zoneKey: "testkey", zoneName: "testzone" },
          () => {
            const html = adminEventNewPage([], TEST_SESSION);
            expect(html).toContain('type="file"');
            expect(html).toContain('name="image"');
            expect(html).toContain("multipart/form-data");
          },
        );
      });

      test("does not show image field on create form when storage is not enabled", () => {
        withStorageDisabled(() => {
          const html = adminEventNewPage([], TEST_SESSION);
          expect(html).not.toContain('type="file"');
        });
      });
    });

    describe("assign_built_site field", () => {
      test("shows assign built site field when CAN_BUILD_SITES is true", () => {
        Deno.env.set("CAN_BUILD_SITES", "true");
        try {
          const html = adminEventNewPage([], TEST_SESSION);
          expect(html).toContain("assign_built_site");
          expect(html).toContain("Assign a site on booking");
        } finally {
          Deno.env.delete("CAN_BUILD_SITES");
        }
      });

      test("hides assign built site field when CAN_BUILD_SITES is not set", () => {
        Deno.env.delete("CAN_BUILD_SITES");
        const html = adminEventNewPage([], TEST_SESSION);
        expect(html).not.toContain("assign_built_site");
      });

      test("shows on edit page when CAN_BUILD_SITES is true", () => {
        Deno.env.set("CAN_BUILD_SITES", "true");
        try {
          const event = testEventWithCount({ assign_built_site: true });
          const html = adminEventEditPage(event, [], TEST_SESSION);
          expect(html).toContain("assign_built_site");
          expect(html).toContain("checked");
        } finally {
          Deno.env.delete("CAN_BUILD_SITES");
        }
      });

      test("shows on duplicate page when CAN_BUILD_SITES is true", () => {
        Deno.env.set("CAN_BUILD_SITES", "true");
        try {
          const event = testEventWithCount({ assign_built_site: true });
          const html = adminDuplicateEventPage(event, [], TEST_SESSION);
          expect(html).toContain("assign_built_site");
        } finally {
          Deno.env.delete("CAN_BUILD_SITES");
        }
      });
    });
  },
);
