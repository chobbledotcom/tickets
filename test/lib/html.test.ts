import { describe, expect, test } from "#test-compat";
import { CSS_PATH, JS_PATH } from "#src/config/asset-paths.ts";
import { adminDashboardPage } from "#templates/admin/dashboard.tsx";
import { adminDuplicateEventPage, adminEventEditPage, adminEventPage, calculateTotalRevenue, formatAddressInline, nearCapacity } from "#templates/admin/events.tsx";
import { adminLoginPage } from "#templates/admin/login.tsx";
import { adminEventActivityLogPage, adminGlobalActivityLogPage } from "#templates/admin/activityLog.tsx";
import { Breadcrumb } from "#templates/admin/nav.tsx";
import { adminSessionsPage } from "#templates/admin/sessions.tsx";
import { adminSettingsPage } from "#templates/admin/settings.tsx";
import { type CsvEventInfo, generateAttendeesCsv, generateCalendarCsv } from "#templates/csv.ts";
import { adminCalendarPage, type CalendarAttendeeRow } from "#templates/admin/calendar.tsx";
import {
  paymentCancelPage,
  paymentErrorPage,
  paymentPage,
  paymentSuccessPage,
} from "#templates/payment.tsx";
import { eventFields } from "#templates/fields.ts";
import { buildMultiTicketEvent, multiTicketPage, notFoundPage, renderEventImage, ticketPage } from "#templates/public.tsx";
import { ticketViewPage } from "#templates/tickets.tsx";
import { testAttendee, testEvent, testEventWithCount } from "#test-utils";

const TEST_CSRF_TOKEN = "test-csrf-token-abc123";
const TEST_SESSION = { csrfToken: TEST_CSRF_TOKEN, adminLevel: "owner" as const };

describe("asset-paths", () => {
  test("CSS_PATH defaults to /mvp.css in dev", () => {
    expect(CSS_PATH).toBe("/mvp.css");
  });

  test("pages include CSS_PATH in stylesheet link", () => {
    const html = adminLoginPage();
    expect(html).toContain(`href="${CSS_PATH}"`);
    expect(html).toContain('rel="stylesheet"');
  });

  test("JS_PATH defaults to /admin.js in dev", () => {
    expect(JS_PATH).toBe("/admin.js");
  });

  test("pages include JS_PATH in deferred script tag", () => {
    const html = adminLoginPage();
    expect(html).toContain(`src="${JS_PATH}"`);
    expect(html).toContain("defer");
  });
});

describe("html", () => {
  describe("adminLoginPage", () => {
    test("renders login form", () => {
      const html = adminLoginPage();
      expect(html).toContain("Login");
      expect(html).toContain('action="/admin/login"');
      expect(html).toContain('type="password"');
    });

    test("shows error when provided", () => {
      const html = adminLoginPage("Invalid password");
      expect(html).toContain("Invalid password");
      expect(html).toContain('class="error"');
    });

    test("escapes error message", () => {
      const html = adminLoginPage("<script>evil()</script>");
      expect(html).toContain("&lt;script&gt;");
    });
  });

  describe("adminDashboardPage", () => {
    test("renders empty state when no events", () => {
      const html = adminDashboardPage([], TEST_SESSION, "localhost");
      expect(html).toContain("Events");
      expect(html).toContain("No events yet");
    });

    test("renders events table", () => {
      const events = [testEventWithCount({ attendee_count: 25 })];
      const html = adminDashboardPage(events, TEST_SESSION, "localhost");
      expect(html).toContain("Test Event");
      expect(html).toContain("25 / 100");
      expect(html).toContain("/admin/event/1");
    });

    test("displays event name", () => {
      const events = [
        testEventWithCount({ name: "My Test Event" }),
      ];
      const html = adminDashboardPage(events, TEST_SESSION, "localhost");
      expect(html).toContain("My Test Event");
      expect(html).toContain("Event Name");
    });

    test("renders create event form", () => {
      const html = adminDashboardPage([], TEST_SESSION, "localhost");
      expect(html).toContain("Create New Event");
      expect(html).toContain('name="name"');
      expect(html).toContain('name="max_attendees"');
      expect(html).toContain('name="thank_you_url"');
    });

    test("includes logout link", () => {
      const html = adminDashboardPage([], TEST_SESSION, "localhost");
      expect(html).toContain("/admin/logout");
    });
  });

  describe("adminEventPage", () => {
    const event = testEventWithCount({ attendee_count: 2 });

    test("renders event name", () => {
      const html = adminEventPage({ event, attendees: [], allowedDomain: "localhost", session: TEST_SESSION });
      expect(html).toContain("Test Event");
    });

    test("shows attendees row with count and remaining", () => {
      const html = adminEventPage({ event, attendees: [], allowedDomain: "localhost", session: TEST_SESSION });
      expect(html).toContain("Attendees");
      expect(html).toContain("2 / 100");
      expect(html).toContain("98 remain");
    });

    test("shows thank you URL in copyable input", () => {
      const html = adminEventPage({ event, attendees: [], allowedDomain: "localhost", session: TEST_SESSION });
      expect(html).toContain("Thank You URL");
      expect(html).toContain('value="https://example.com/thanks"');
      expect(html).toContain("readonly");
      expect(html).toContain("data-select-on-click");
    });

    test("shows public URL with allowed domain", () => {
      const html = adminEventPage({ event, attendees: [], allowedDomain: "example.com", session: TEST_SESSION });
      expect(html).toContain("Public URL");
      expect(html).toContain('href="https://example.com/ticket/ab12c"');
      expect(html).toContain("example.com/ticket/ab12c");
    });

    test("shows embed code with allowed domain and iframe param", () => {
      const html = adminEventPage({ event, attendees: [], allowedDomain: "example.com", session: TEST_SESSION });
      expect(html).toContain("Embed Code");
      expect(html).toContain("https://example.com/ticket/ab12c?iframe=true");
      expect(html).toContain("loading=");
      expect(html).toContain("readonly");
    });

    test("embed code uses 18rem height for email-only events", () => {
      const emailEvent = testEventWithCount({ attendee_count: 2, fields: "email" });
      const html = adminEventPage({ event: emailEvent, attendees: [], allowedDomain: "example.com", session: TEST_SESSION });
      expect(html).toContain("height: 18rem");
    });

    test("embed code uses 22rem height for email,phone fields events", () => {
      const bothEvent = testEventWithCount({ attendee_count: 2, fields: "email,phone" });
      const html = adminEventPage({ event: bothEvent, attendees: [], allowedDomain: "example.com", session: TEST_SESSION });
      expect(html).toContain("height: 22rem");
    });

    test("embed code uses 20rem height for address-only events", () => {
      const addressEvent = testEventWithCount({ attendee_count: 2, fields: "address" });
      const html = adminEventPage({ event: addressEvent, attendees: [], allowedDomain: "example.com", session: TEST_SESSION });
      expect(html).toContain("height: 20rem");
    });

    test("embed code uses 28rem height for email,phone,address events", () => {
      const allFieldsEvent = testEventWithCount({ attendee_count: 2, fields: "email,phone,address" });
      const html = adminEventPage({ event: allFieldsEvent, attendees: [], allowedDomain: "example.com", session: TEST_SESSION });
      expect(html).toContain("height: 28rem");
    });

    test("embed code uses 18rem height for phone-only events", () => {
      const phoneEvent = testEventWithCount({ attendee_count: 2, fields: "phone" });
      const html = adminEventPage({ event: phoneEvent, attendees: [], allowedDomain: "example.com", session: TEST_SESSION });
      expect(html).toContain("height: 18rem");
    });

    test("renders empty attendees state", () => {
      const html = adminEventPage({ event, attendees: [], allowedDomain: "localhost", session: TEST_SESSION });
      expect(html).toContain("No attendees yet");
    });

    test("renders attendees table", () => {
      const attendees = [testAttendee()];
      const html = adminEventPage({ event, attendees, allowedDomain: "localhost", session: TEST_SESSION });
      expect(html).toContain("John Doe");
      expect(html).toContain("john@example.com");
    });

    test("escapes attendee data", () => {
      const attendees = [testAttendee({ name: "<script>evil()</script>" })];
      const html = adminEventPage({ event, attendees, allowedDomain: "localhost", session: TEST_SESSION });
      expect(html).toContain("&lt;script&gt;");
    });

    test("includes back link", () => {
      const html = adminEventPage({ event, attendees: [], allowedDomain: "localhost", session: TEST_SESSION });
      expect(html).toContain("/admin/");
    });

    test("shows phone column in attendee table", () => {
      const html = adminEventPage({ event, attendees: [], allowedDomain: "localhost", session: TEST_SESSION });
      expect(html).toContain("<th>Phone</th>");
    });

    test("shows attendee phone in table row", () => {
      const attendees = [testAttendee({ phone: "+1 555 123 4567" })];
      const html = adminEventPage({ event, attendees, allowedDomain: "localhost", session: TEST_SESSION });
      expect(html).toContain("+1 555 123 4567");
    });

    test("renders empty string for attendee without email", () => {
      const attendees = [testAttendee({ email: "" })];
      const html = adminEventPage({ event, attendees, allowedDomain: "localhost", session: TEST_SESSION });
      expect(html).toContain("John Doe");
      expect(html).toContain("<td></td>");
    });

    test("shows danger-text class when near capacity", () => {
      const nearFullEvent = testEventWithCount({ attendee_count: 91, max_attendees: 100 });
      const html = adminEventPage({ event: nearFullEvent, attendees: [], allowedDomain: "localhost", session: TEST_SESSION });
      expect(html).toContain('class="danger-text"');
      expect(html).toContain("9 remain");
    });

    test("does not show danger-text class when not near capacity", () => {
      const html = adminEventPage({ event, attendees: [], allowedDomain: "localhost", session: TEST_SESSION });
      expect(html).not.toContain('class="danger-text"');
    });

    test("shows deactivated alert for inactive events", () => {
      const inactive = testEventWithCount({ active: 0, attendee_count: 0 });
      const html = adminEventPage({ event: inactive, attendees: [], allowedDomain: "localhost", session: TEST_SESSION });
      expect(html).toContain('class="error"');
      expect(html).toContain("This event is deactivated and cannot be booked");
    });

    test("does not show deactivated alert for active events", () => {
      const html = adminEventPage({ event, attendees: [], allowedDomain: "localhost", session: TEST_SESSION });
      expect(html).not.toContain("This event is deactivated and cannot be booked");
    });

    test("shows ticket column header", () => {
      const html = adminEventPage({ event, attendees: [], allowedDomain: "localhost", session: TEST_SESSION });
      expect(html).toContain("<th>Ticket</th>");
    });

    test("shows ticket token as link to public ticket URL", () => {
      const attendees = [testAttendee({ ticket_token: "abc123" })];
      const html = adminEventPage({ event, attendees, allowedDomain: "mysite.com", session: TEST_SESSION });
      expect(html).toContain('href="https://mysite.com/t/abc123"');
      expect(html).toContain("abc123");
    });

    test("renders empty date cell for attendee without date on daily event", () => {
      const dailyEvent = testEventWithCount({ event_type: "daily", attendee_count: 1 });
      const attendees = [testAttendee({ date: null })];
      const html = adminEventPage({ event: dailyEvent, attendees, allowedDomain: "localhost", session: TEST_SESSION });
      expect(html).toContain("<th>Date</th>");
    });

    test("shows unlimited booking window when maximum_days_after is 0", () => {
      const dailyEvent = testEventWithCount({ event_type: "daily", maximum_days_after: 0 });
      const html = adminEventPage({ event: dailyEvent, attendees: [], allowedDomain: "localhost", session: TEST_SESSION });
      expect(html).toContain("unlimited");
    });

    test("shows numeric booking window when maximum_days_after is nonzero", () => {
      const dailyEvent = testEventWithCount({ event_type: "daily", maximum_days_after: 30 });
      const html = adminEventPage({ event: dailyEvent, attendees: [], allowedDomain: "localhost", session: TEST_SESSION });
      expect(html).toContain("to 30 days");
      expect(html).not.toContain("unlimited");
    });

    test("shows danger-text for daily event at capacity with date filter", () => {
      const dailyEvent = testEventWithCount({ event_type: "daily", attendee_count: 0, max_attendees: 2 });
      const attendees = [testAttendee(), testAttendee({ id: 2, name: "Jane" })];
      const html = adminEventPage({
        event: dailyEvent,
        attendees,
        allowedDomain: "localhost",
        session: TEST_SESSION,
        dateFilter: "2026-03-15",
      });
      expect(html).toContain('class="danger-text"');
      expect(html).toContain("0 remain");
    });
  });

  describe("ticketPage", () => {
    const event = testEventWithCount({ attendee_count: 50 });
    const csrfToken = "test-csrf-token";
    const renderTicket = (
      ev: Parameters<typeof ticketPage>[0],
      opts?: { error?: string; isClosed?: boolean; iframe?: boolean; dates?: string[]; terms?: string | null },
    ) => ticketPage(ev, csrfToken, opts?.error, opts?.isClosed ?? false, opts?.iframe ?? false, opts?.dates, opts?.terms);

    test("renders page title", () => {
      const html = renderTicket(event);
      expect(html).toContain("Test Event");
    });

    test("renders registration form when spots available", () => {
      const html = renderTicket(event);
      expect(html).toContain('action="/ticket/ab12c"');
      expect(html).toContain('name="name"');
      expect(html).toContain('name="email"');
      expect(html).toContain("Reserve Ticket");
    });

    test("includes CSRF token in form", () => {
      const html = renderTicket(event);
      expect(html).toContain('name="csrf_token"');
      expect(html).toContain(`value="${csrfToken}"`);
    });

    test("shows error when provided", () => {
      const html = renderTicket(event, { error: "Name and email are required" });
      expect(html).toContain("Name and email are required");
      expect(html).toContain('class="error"');
    });

    test("shows full message when no spots", () => {
      const fullEvent = testEventWithCount({ attendee_count: 100 });
      const html = renderTicket(fullEvent);
      expect(html).toContain("this event is full");
      expect(html).not.toContain(">Reserve Ticket</button>");
    });

    test("displays event name as header", () => {
      const html = renderTicket(event);
      expect(html).toContain("<h1>Test Event</h1>");
    });

    test("shows quantity selector when max_quantity > 1 and spots available", () => {
      const multiTicketEvent = testEventWithCount({
        max_quantity: 5,
        attendee_count: 0,
      });
      const html = renderTicket(multiTicketEvent);
      expect(html).toContain("Number of Tickets");
      expect(html).toContain('name="quantity"');
      expect(html).toContain('<option value="1">1</option>');
      expect(html).toContain('<option value="5">5</option>');
      expect(html).toContain("Reserve Tickets"); // Plural
    });

    test("limits quantity selector to remaining spots", () => {
      const limitedEvent = testEventWithCount({
        max_quantity: 10,
        attendee_count: 97, // Only 3 spots remaining
      });
      const html = renderTicket(limitedEvent);
      expect(html).toContain("Number of Tickets");
      expect(html).toContain('<option value="3">3</option>');
      expect(html).not.toContain('<option value="4">4</option>');
    });

    test("hides quantity selector when max_quantity is 1", () => {
      const html = renderTicket(event); // max_quantity is 1
      expect(html).not.toContain("Number of Tickets");
      expect(html).toContain('type="hidden" name="quantity" value="1"');
      expect(html).toContain("Reserve Ticket"); // Singular
      expect(html).not.toContain("Reserve Tickets"); // Not plural
    });

    test("shows phone field for phone-only events", () => {
      const phoneEvent = testEventWithCount({ attendee_count: 50, fields: "phone" });
      const html = renderTicket(phoneEvent);
      expect(html).toContain('name="phone"');
      expect(html).toContain("Your Phone Number");
      expect(html).not.toContain('name="email"');
    });

    test("shows both email and phone for email,phone setting", () => {
      const bothEvent = testEventWithCount({ attendee_count: 50, fields: "email,phone" });
      const html = renderTicket(bothEvent);
      expect(html).toContain('name="email"');
      expect(html).toContain('name="phone"');
    });

    test("shows only email for email setting", () => {
      const html = renderTicket(event);
      expect(html).toContain('name="email"');
      expect(html).not.toContain('name="phone"');
    });

    test("hides header and description in iframe mode", () => {
      const eventWithDesc = testEventWithCount({ attendee_count: 50, description: "A great event" });
      const html = renderTicket(eventWithDesc, { iframe: true });
      expect(html).not.toContain("<h1>");
      expect(html).not.toContain("A great event");
      expect(html).toContain('class="iframe"');
      expect(html).toContain('name="name"');
    });

    test("shows header and description when not in iframe mode", () => {
      const eventWithDesc = testEventWithCount({ attendee_count: 50, description: "A great event" });
      const html = renderTicket(eventWithDesc);
      expect(html).toContain("<h1>Test Event</h1>");
      expect(html).toContain("A great event");
      expect(html).not.toContain('class="iframe"');
    });
  });

  describe("notFoundPage", () => {
    test("renders not found message", () => {
      const html = notFoundPage();
      expect(html).toContain("<h1>Not Found</h1>");
    });
  });

  describe("paymentPage", () => {
    const event = testEvent({ unit_price: 1000 });
    const attendee = testAttendee();

    test("renders payment details", () => {
      const html = paymentPage(
        event,
        attendee,
        "https://checkout.stripe.com/session",
        "£10.00",
      );
      expect(html).toContain("Complete Your Payment");
      expect(html).toContain("John Doe");
      expect(html).toContain("john@example.com");
      expect(html).toContain("£10.00");
    });

    test("includes checkout URL", () => {
      const html = paymentPage(
        event,
        attendee,
        "https://checkout.stripe.com/session",
        "£10.00",
      );
      expect(html).toContain("https://checkout.stripe.com/session");
      expect(html).toContain("Pay Now");
    });

    test("escapes user data", () => {
      const evilAttendee = testAttendee({ name: "<script>evil()</script>" });
      const html = paymentPage(
        event,
        evilAttendee,
        "https://checkout.stripe.com/session",
        "£10.00",
      );
      expect(html).toContain("&lt;script&gt;");
    });
  });

  describe("paymentSuccessPage", () => {
    const event = testEvent({ unit_price: 1000 });

    test("renders success message", () => {
      const html = paymentSuccessPage(event, "https://example.com/thanks");
      expect(html).toContain("Payment Successful");
      expect(html).toContain("https://example.com/thanks");
    });

    test("includes meta refresh redirect", () => {
      const html = paymentSuccessPage(event, "https://example.com/thanks");
      expect(html).toContain('http-equiv="refresh"');
      expect(html).toContain("3;url=https://example.com/thanks");
    });
  });

  describe("paymentCancelPage", () => {
    const event = testEvent({ unit_price: 1000 });

    test("renders cancel message", () => {
      const html = paymentCancelPage(event, "/ticket/ab12c");
      expect(html).toContain("Payment Cancelled");
      expect(html).toContain("/ticket/ab12c");
      expect(html).toContain("Try again");
    });
  });

  describe("paymentErrorPage", () => {
    test("renders error message", () => {
      const html = paymentErrorPage("Payment verification failed");
      expect(html).toContain("Payment Error");
      expect(html).toContain("Payment verification failed");
      expect(html).toContain('class="error"');
    });

    test("escapes error message", () => {
      const html = paymentErrorPage("<script>evil()</script>");
      expect(html).toContain("&lt;script&gt;");
    });

    test("includes home link", () => {
      const html = paymentErrorPage("Error");
      expect(html).toContain('href="/"');
    });
  });

  describe("adminDashboardPage unit_price field", () => {
    test("renders unit_price input field", () => {
      const html = adminDashboardPage([], TEST_SESSION, "localhost");
      expect(html).toContain('name="unit_price"');
      expect(html).toContain("Ticket Price");
    });
  });

  describe("adminEventPage export button", () => {
    test("renders export CSV button", () => {
      const event = testEventWithCount({ attendee_count: 2 });
      const html = adminEventPage({ event, attendees: [], allowedDomain: "localhost", session: TEST_SESSION });
      expect(html).toContain("/admin/event/1/export");
      expect(html).toContain("Export CSV");
    });
  });

  describe("generateAttendeesCsv", () => {
    test("generates CSV header for empty attendees", () => {
      const csv = generateAttendeesCsv([]);
      expect(csv).toBe("Name,Email,Phone,Address,Special Instructions,Quantity,Registered,Price Paid,Transaction ID,Checked In,Ticket Token,Ticket URL");
    });

    test("generates CSV with attendee data", () => {
      const attendees = [
        testAttendee({ created: "2024-01-15T10:30:00Z", quantity: 2 }),
      ];
      const csv = generateAttendeesCsv(attendees);
      const lines = csv.split("\n");
      expect(lines[0]).toBe("Name,Email,Phone,Address,Special Instructions,Quantity,Registered,Price Paid,Transaction ID,Checked In,Ticket Token,Ticket URL");
      expect(lines[1]).toContain("John Doe");
      expect(lines[1]).toContain("john@example.com");
      expect(lines[1]).toContain(",2,");
      expect(lines[1]).toContain("2024-01-15T10:30:00.000Z");
    });

    test("escapes values with commas", () => {
      const attendees = [testAttendee({ name: "Doe, John" })];
      const csv = generateAttendeesCsv(attendees);
      expect(csv).toContain('"Doe, John"');
    });

    test("escapes values with quotes", () => {
      const attendees = [testAttendee({ name: 'John "JD" Doe' })];
      const csv = generateAttendeesCsv(attendees);
      expect(csv).toContain('"John ""JD"" Doe"');
    });

    test("escapes values with newlines", () => {
      const attendees = [testAttendee({ name: "John\nDoe" })];
      const csv = generateAttendeesCsv(attendees);
      expect(csv).toContain('"John\nDoe"');
    });

    test("generates multiple rows", () => {
      const attendees = [
        testAttendee(),
        testAttendee({
          id: 2,
          name: "Jane Smith",
          email: "jane@example.com",
          created: "2024-01-16T11:00:00Z",
          quantity: 3,
        }),
      ];
      const csv = generateAttendeesCsv(attendees);
      const lines = csv.split("\n");
      expect(lines).toHaveLength(3);
      expect(lines[1]).toContain("John Doe");
      expect(lines[2]).toContain("Jane Smith");
    });

    test("includes phone number in CSV output", () => {
      const attendees = [testAttendee({ phone: "+1 555 123 4567" })];
      const csv = generateAttendeesCsv(attendees);
      const lines = csv.split("\n");
      expect(lines[0]).toBe("Name,Email,Phone,Address,Special Instructions,Quantity,Registered,Price Paid,Transaction ID,Checked In,Ticket Token,Ticket URL");
      expect(lines[1]).toContain("+1 555 123 4567");
    });

    test("includes empty phone column when phone not collected", () => {
      const attendees = [testAttendee()];
      const csv = generateAttendeesCsv(attendees);
      const lines = csv.split("\n");
      expect(lines[1]).toContain("john@example.com,,,,1,");
    });

    test("generates CSV with price and transaction ID", () => {
      const attendees = [
        testAttendee({
          payment_id: "pi_abc123",
          quantity: 2,
          price_paid: "2000",
        }),
      ];
      const csv = generateAttendeesCsv(attendees);
      const lines = csv.split("\n");
      expect(lines[1]).toContain("20.00");
      expect(lines[1]).toContain("pi_abc123");
    });

    test("formats price as empty when null", () => {
      const attendees = [testAttendee()];
      const csv = generateAttendeesCsv(attendees);
      const lines = csv.split("\n");
      // Price and transaction ID should be empty, followed by Checked In, Token, URL
      expect(lines[1]).toContain(",,,No,");
    });

    test("shared transaction ID across multiple attendees", () => {
      const attendees = [
        testAttendee({
          payment_id: "pi_shared_123",
          price_paid: "1000",
        }),
        testAttendee({
          id: 2,
          event_id: 2,
          payment_id: "pi_shared_123",
          quantity: 2,
          price_paid: "3000",
        }),
      ];
      const csv = generateAttendeesCsv(attendees);
      const lines = csv.split("\n");
      expect(lines[1]).toContain("10.00");
      expect(lines[1]).toContain("pi_shared_123");
      expect(lines[2]).toContain("30.00");
      expect(lines[2]).toContain("pi_shared_123");
    });

    test("includes Checked In as Yes for checked-in attendee", () => {
      const attendees = [testAttendee({ checked_in: "true" })];
      const csv = generateAttendeesCsv(attendees);
      const lines = csv.split("\n");
      expect(lines[1]).toContain(",Yes,");
    });

    test("includes Checked In as No for not checked-in attendee", () => {
      const attendees = [testAttendee({ checked_in: "false" })];
      const csv = generateAttendeesCsv(attendees);
      const lines = csv.split("\n");
      expect(lines[1]).toContain(",No,");
    });

    test("includes ticket token and URL in CSV output", () => {
      const attendees = [testAttendee({ ticket_token: "abc123" })];
      const csv = generateAttendeesCsv(attendees);
      const lines = csv.split("\n");
      expect(lines[1]).toContain("abc123");
      expect(lines[1]).toContain("https://localhost/t/abc123");
    });

    test("includes Date column when includeDate is true", () => {
      const csv = generateAttendeesCsv([], true);
      expect(csv).toBe("Date,Name,Email,Phone,Address,Special Instructions,Quantity,Registered,Price Paid,Transaction ID,Checked In,Ticket Token,Ticket URL");
    });

    test("includes date value in row when includeDate is true", () => {
      const attendees = [testAttendee({ date: "2026-03-15" })];
      const csv = generateAttendeesCsv(attendees, true);
      const lines = csv.split("\n");
      expect(lines[0]).toContain("Date,Name");
      expect(lines[1]).toMatch(/^2026-03-15,/);
    });

    test("includes empty date in row when date is null", () => {
      const attendees = [testAttendee({ date: null })];
      const csv = generateAttendeesCsv(attendees, true);
      const lines = csv.split("\n");
      expect(lines[1]).toMatch(/^,John Doe/);
    });

    test("omits Date column when includeDate is false", () => {
      const attendees = [testAttendee({ date: "2026-03-15" })];
      const csv = generateAttendeesCsv(attendees, false);
      expect(csv.startsWith("Name,")).toBe(true);
      expect(csv).not.toContain("2026-03-15");
    });
  });

  describe("adminEventPage filter links", () => {
    test("renders All / Checked In / Checked Out links", () => {
      const event = testEventWithCount({ attendee_count: 1 });
      const attendees = [testAttendee()];
      const html = adminEventPage({ event, attendees, allowedDomain: "localhost", session: TEST_SESSION });
      expect(html).toContain("All");
      expect(html).toContain("Checked In");
      expect(html).toContain("Checked Out");
    });

    test("bolds All when no filter is active", () => {
      const event = testEventWithCount({ attendee_count: 1 });
      const attendees = [testAttendee()];
      const html = adminEventPage({ event, attendees, allowedDomain: "localhost", session: TEST_SESSION });
      expect(html).toContain("<strong>All</strong>");
      expect(html).toContain(`href="/admin/event/${event.id}/in#attendees"`);
      expect(html).toContain(`href="/admin/event/${event.id}/out#attendees"`);
    });

    test("bolds Checked In when filter is in", () => {
      const event = testEventWithCount({ attendee_count: 1 });
      const attendees = [testAttendee()];
      const html = adminEventPage({ event, attendees, allowedDomain: "localhost", session: TEST_SESSION, activeFilter: "in" });
      expect(html).toContain("<strong>Checked In</strong>");
      expect(html).toContain(`href="/admin/event/${event.id}#attendees"`);
    });

    test("bolds Checked Out when filter is out", () => {
      const event = testEventWithCount({ attendee_count: 1 });
      const attendees = [testAttendee()];
      const html = adminEventPage({ event, attendees, allowedDomain: "localhost", session: TEST_SESSION, activeFilter: "out" });
      expect(html).toContain("<strong>Checked Out</strong>");
    });

    test("filters to only checked-in attendees when filter is in", () => {
      const event = testEventWithCount({ attendee_count: 2 });
      const attendees = [
        testAttendee({ id: 1, name: "Checked In User", checked_in: "true" }),
        testAttendee({ id: 2, name: "Not Checked In User", checked_in: "false" }),
      ];
      const html = adminEventPage({ event, attendees, allowedDomain: "localhost", session: TEST_SESSION, activeFilter: "in" });
      expect(html).toContain("Checked In User");
      expect(html).not.toContain("Not Checked In User");
    });

    test("filters to only checked-out attendees when filter is out", () => {
      const event = testEventWithCount({ attendee_count: 2 });
      const attendees = [
        testAttendee({ id: 1, name: "Alice InPerson", checked_in: "true" }),
        testAttendee({ id: 2, name: "Bob Remote", checked_in: "false" }),
      ];
      const html = adminEventPage({ event, attendees, allowedDomain: "localhost", session: TEST_SESSION, activeFilter: "out" });
      expect(html).not.toContain("Alice InPerson");
      expect(html).toContain("Bob Remote");
    });

    test("shows all attendees when filter is all", () => {
      const event = testEventWithCount({ attendee_count: 2 });
      const attendees = [
        testAttendee({ id: 1, name: "Checked In User", checked_in: "true" }),
        testAttendee({ id: 2, name: "Not Checked In User", checked_in: "false" }),
      ];
      const html = adminEventPage({ event, attendees, allowedDomain: "localhost", session: TEST_SESSION, activeFilter: "all" });
      expect(html).toContain("Checked In User");
      expect(html).toContain("Not Checked In User");
    });

    test("includes return_filter hidden field in checkin form", () => {
      const event = testEventWithCount({ attendee_count: 1 });
      const attendees = [testAttendee({ checked_in: "true" })];
      const html = adminEventPage({ event, attendees, allowedDomain: "localhost", session: TEST_SESSION, activeFilter: "in" });
      expect(html).toContain('name="return_filter"');
      expect(html).toContain('value="in"');
    });
  });

  describe("adminEventActivityLogPage", () => {
    test("renders activity log entries", () => {
      const event = testEventWithCount();
      const entries = [
        { id: 1, created: "2024-01-15T10:30:00Z", event_id: 1, message: "Ticket reserved" },
        { id: 2, created: "2024-01-15T11:00:00Z", event_id: 1, message: "Payment received" },
      ];
      const html = adminEventActivityLogPage(event, entries);
      expect(html).toContain("Ticket reserved");
      expect(html).toContain("Payment received");
      expect(html).toContain("Log");
    });

    test("renders empty state when no entries", () => {
      const event = testEventWithCount();
      const html = adminEventActivityLogPage(event, []);
      expect(html).toContain("No activity recorded yet");
    });
  });

  describe("adminGlobalActivityLogPage", () => {
    test("renders global activity log with entries", () => {
      const entries = [
        { id: 1, created: "2024-01-15T10:30:00Z", event_id: null, message: "System started" },
      ];
      const html = adminGlobalActivityLogPage(entries);
      expect(html).toContain("System started");
      expect(html).toContain("Log");
    });

    test("renders empty state when no entries", () => {
      const html = adminGlobalActivityLogPage([]);
      expect(html).toContain("No activity recorded yet");
    });

    test("shows truncation message when truncated", () => {
      const entries = [
        { id: 1, created: "2024-01-15T10:30:00Z", event_id: null, message: "Action" },
      ];
      const html = adminGlobalActivityLogPage(entries, true);
      expect(html).toContain("Showing the most recent 200 entries");
    });

    test("does not show truncation message when not truncated", () => {
      const entries = [
        { id: 1, created: "2024-01-15T10:30:00Z", event_id: null, message: "Action" },
      ];
      const html = adminGlobalActivityLogPage(entries, false);
      expect(html).not.toContain("Showing the most recent 200 entries");
    });
  });

  describe("adminDashboardPage inactive events", () => {
    test("renders inactive event with reduced opacity", () => {
      const events = [testEventWithCount({ active: 0, attendee_count: 5 })];
      const html = adminDashboardPage(events, TEST_SESSION, "localhost");
      expect(html).toContain("opacity: 0.5");
      expect(html).toContain("Inactive");
    });
  });

  describe("adminDashboardPage multi-booking link", () => {
    test("does not show multi-booking section with zero events", () => {
      const html = adminDashboardPage([], TEST_SESSION, "localhost");
      expect(html).not.toContain("Multi-booking link");
    });

    test("does not show multi-booking section with one active event", () => {
      const events = [testEventWithCount({ id: 1, slug: "ab12c" })];
      const html = adminDashboardPage(events, TEST_SESSION, "localhost");
      expect(html).not.toContain("Multi-booking link");
    });

    test("shows multi-booking section with two active events", () => {
      const events = [
        testEventWithCount({ id: 1, slug: "ab12c", name: "Event A" }),
        testEventWithCount({ id: 2, slug: "cd34e", name: "Event B" }),
      ];
      const html = adminDashboardPage(events, TEST_SESSION, "localhost");
      expect(html).toContain("Multi-booking link");
      expect(html).toContain("Event A");
      expect(html).toContain("Event B");
    });

    test("does not count inactive events toward threshold", () => {
      const events = [
        testEventWithCount({ id: 1, slug: "ab12c", active: 1 }),
        testEventWithCount({ id: 2, slug: "cd34e", active: 0 }),
      ];
      const html = adminDashboardPage(events, TEST_SESSION, "localhost");
      expect(html).not.toContain("Multi-booking link");
    });

    test("excludes inactive events from checkboxes", () => {
      const events = [
        testEventWithCount({ id: 1, slug: "ab12c", name: "Active One", active: 1 }),
        testEventWithCount({ id: 2, slug: "cd34e", name: "Inactive", active: 0 }),
        testEventWithCount({ id: 3, slug: "ef56g", name: "Active Two", active: 1 }),
      ];
      const html = adminDashboardPage(events, TEST_SESSION, "localhost");
      expect(html).toContain("Active One");
      expect(html).toContain("Active Two");
      expect(html).not.toContain('data-multi-booking-slug="cd34e"');
    });

    test("renders checkboxes with slug data attributes", () => {
      const events = [
        testEventWithCount({ id: 1, slug: "ab12c" }),
        testEventWithCount({ id: 2, slug: "cd34e" }),
      ];
      const html = adminDashboardPage(events, TEST_SESSION, "localhost");
      expect(html).toContain('data-multi-booking-slug="ab12c"');
      expect(html).toContain('data-multi-booking-slug="cd34e"');
    });

    test("renders URL input with domain data attribute", () => {
      const events = [
        testEventWithCount({ id: 1, slug: "ab12c" }),
        testEventWithCount({ id: 2, slug: "cd34e" }),
      ];
      const html = adminDashboardPage(events, TEST_SESSION, "example.com");
      expect(html).toContain('data-domain="example.com"');
      expect(html).toContain("data-multi-booking-url");
      expect(html).toContain("readonly");
      expect(html).toContain('for="multi-booking-url"');
      expect(html).toContain('id="multi-booking-url"');
    });

    test("is collapsed by default via details element", () => {
      const events = [
        testEventWithCount({ id: 1, slug: "ab12c" }),
        testEventWithCount({ id: 2, slug: "cd34e" }),
      ];
      const html = adminDashboardPage(events, TEST_SESSION, "localhost");
      expect(html).toContain("<details>");
      expect(html).toContain("<summary>");
    });

    test("renders embed code input", () => {
      const events = [
        testEventWithCount({ id: 1, slug: "ab12c", fields: "email" }),
        testEventWithCount({ id: 2, slug: "cd34e", fields: "email,phone" }),
      ];
      const html = adminDashboardPage(events, TEST_SESSION, "example.com");
      expect(html).toContain("data-multi-booking-embed");
      expect(html).toContain('for="multi-booking-embed"');
      expect(html).toContain('id="multi-booking-embed"');
    });

    test("checkboxes include data-fields attribute for embed code generation", () => {
      const events = [
        testEventWithCount({ id: 1, slug: "ab12c", fields: "email" }),
        testEventWithCount({ id: 2, slug: "cd34e", fields: "email,phone" }),
      ];
      const html = adminDashboardPage(events, TEST_SESSION, "localhost");
      expect(html).toContain('data-fields="email"');
      expect(html).toContain('data-fields="email,phone"');
    });
  });

  describe("calculateTotalRevenue", () => {
    test("returns 0 for empty attendees", () => {
      expect(calculateTotalRevenue([])).toBe(0);
    });

    test("sums price_paid from attendees", () => {
      const attendees = [
        testAttendee({ price_paid: "1000" }),
        testAttendee({ id: 2, price_paid: "2000" }),
      ];
      expect(calculateTotalRevenue(attendees)).toBe(3000);
    });

    test("returns 0 when attendees have no price_paid", () => {
      const attendees = [testAttendee({ quantity: 3 })];
      expect(calculateTotalRevenue(attendees)).toBe(0);
    });

    test("skips attendees without price_paid when summing", () => {
      const attendees = [
        testAttendee({ price_paid: "1500" }),
        testAttendee({ id: 2, quantity: 2 }),
      ];
      expect(calculateTotalRevenue(attendees)).toBe(1500);
    });
  });

  describe("adminEventPage total revenue", () => {
    test("shows total revenue for paid events", () => {
      const event = testEventWithCount({ unit_price: 1000, attendee_count: 2 });
      const attendees = [
        testAttendee({ price_paid: "1000" }),
        testAttendee({ id: 2, price_paid: "2000" }),
      ];
      const html = adminEventPage({ event, attendees, allowedDomain: "localhost", session: TEST_SESSION });
      expect(html).toContain("Total Revenue");
      expect(html).toContain("30.00");
    });

    test("does not show total revenue for free events", () => {
      const event = testEventWithCount({ unit_price: null, attendee_count: 1 });
      const attendees = [testAttendee()];
      const html = adminEventPage({ event, attendees, allowedDomain: "localhost", session: TEST_SESSION });
      expect(html).not.toContain("Total Revenue");
    });

    test("shows 0.00 revenue for paid event with no attendees", () => {
      const event = testEventWithCount({ unit_price: 1000, attendee_count: 0 });
      const html = adminEventPage({ event, attendees: [], allowedDomain: "localhost", session: TEST_SESSION });
      expect(html).toContain("Total Revenue");
      expect(html).toContain("0.00");
    });
  });

  describe("adminEventPage optional fields", () => {
    test("shows reactivate link for inactive events", () => {
      const event = testEventWithCount({ active: 0, attendee_count: 0 });
      const html = adminEventPage({ event, attendees: [], allowedDomain: "localhost", session: TEST_SESSION });
      expect(html).toContain("/reactivate");
      expect(html).toContain("Reactivate");
    });

    test("shows simple success message text when no thank_you_url", () => {
      const event = testEventWithCount({ thank_you_url: null, attendee_count: 0 });
      const html = adminEventPage({ event, attendees: [], allowedDomain: "localhost", session: TEST_SESSION });
      expect(html).toContain("None (shows simple success message)");
    });

    test("shows webhook URL in copyable input when present", () => {
      const event = testEventWithCount({ webhook_url: "https://hooks.example.com/notify", attendee_count: 0 });
      const html = adminEventPage({ event, attendees: [], allowedDomain: "localhost", session: TEST_SESSION });
      expect(html).toContain("Webhook URL");
      expect(html).toContain('value="https://hooks.example.com/notify"');
      expect(html).toContain("readonly");
    });
  });

  describe("nearCapacity", () => {
    test("returns true when at 90% capacity", () => {
      const event = testEventWithCount({ attendee_count: 90, max_attendees: 100 });
      expect(nearCapacity(event)).toBe(true);
    });

    test("returns true when over 90% capacity", () => {
      const event = testEventWithCount({ attendee_count: 95, max_attendees: 100 });
      expect(nearCapacity(event)).toBe(true);
    });

    test("returns false when under 90% capacity", () => {
      const event = testEventWithCount({ attendee_count: 89, max_attendees: 100 });
      expect(nearCapacity(event)).toBe(false);
    });

    test("returns true when fully sold out", () => {
      const event = testEventWithCount({ attendee_count: 100, max_attendees: 100 });
      expect(nearCapacity(event)).toBe(true);
    });
  });

  describe("formatAddressInline", () => {
    test("returns empty string for empty input", () => {
      expect(formatAddressInline("")).toBe("");
    });

    test("returns single line unchanged", () => {
      expect(formatAddressInline("123 Main St")).toBe("123 Main St");
    });

    test("joins multiple lines with comma-space", () => {
      expect(formatAddressInline("123 Main St\nSpringfield\nIL 62701")).toBe(
        "123 Main St, Springfield, IL 62701",
      );
    });

    test("handles Windows line endings (CRLF)", () => {
      expect(formatAddressInline("123 Main St\r\nSpringfield")).toBe(
        "123 Main St, Springfield",
      );
    });

    test("does not double-comma when line ends with comma", () => {
      expect(formatAddressInline("123 Main St,\nSpringfield")).toBe(
        "123 Main St, Springfield",
      );
    });

    test("trims whitespace from lines", () => {
      expect(formatAddressInline("  123 Main St  \n  Springfield  ")).toBe(
        "123 Main St, Springfield",
      );
    });

    test("skips blank lines", () => {
      expect(formatAddressInline("123 Main St\n\n\nSpringfield")).toBe(
        "123 Main St, Springfield",
      );
    });
  });

  describe("Breadcrumb", () => {
    test("renders breadcrumb link with label", () => {
      const html = String(Breadcrumb({ href: "/admin/", label: "Back to Events" }));
      expect(html).toContain('href="/admin/"');
      expect(html).toContain("Back to Events");
      expect(html).toContain("\u2190");
    });
  });

  describe("adminSessionsPage", () => {
    test("renders session rows", () => {
      const sessions = [
        { token: "abcdefghijklmnop", csrf_token: "csrf1", expires: Date.now() + 86400000, wrapped_data_key: null, user_id: 1 },
        { token: "qrstuvwxyz123456", csrf_token: "csrf2", expires: Date.now() + 86400000, wrapped_data_key: null, user_id: 2 },
      ];
      const html = adminSessionsPage(sessions, "abcdefghijklmnop", TEST_SESSION);
      expect(html).toContain("abcdefgh...");
      expect(html).toContain("qrstuvwx...");
      expect(html).toContain("Current");
    });

    test("renders empty state when no sessions", () => {
      const html = adminSessionsPage([], "some-token", TEST_SESSION);
      expect(html).toContain("No sessions");
    });
  });

  describe("multiTicketPage", () => {
    test("shows all sold out message when every event is sold out", () => {
      const events = [
        buildMultiTicketEvent(testEventWithCount({ id: 1, slug: "ab12c", name: "Event A", attendee_count: 100, max_attendees: 100 })),
        buildMultiTicketEvent(testEventWithCount({ id: 2, slug: "cd34e", name: "Event B", attendee_count: 50, max_attendees: 50 })),
      ];
      const html = multiTicketPage(events, ["ab12c", "cd34e"], TEST_CSRF_TOKEN);
      expect(html).toContain("Sorry, all events are sold out.");
      expect(html).not.toContain("Reserve Tickets</button>");
    });
  });

  describe("adminSettingsPage", () => {
    test("shows square webhook configured message when key is set", () => {
      const html = adminSettingsPage(
        TEST_SESSION,
        false, // stripeKeyConfigured
        "square", // paymentProvider
        undefined, // error
        undefined, // success
        true, // squareTokenConfigured
        true, // squareWebhookConfigured
        "https://example.com/payment/webhook",
      );
      expect(html).toContain("A webhook signature key is currently configured");
      expect(html).toContain("Enter a new key below to replace it");
    });

    test("shows fallback text when webhookUrl is not provided", () => {
      const html = adminSettingsPage(
        TEST_SESSION,
        false, // stripeKeyConfigured
        "square", // paymentProvider
        undefined, // error
        undefined, // success
        true, // squareTokenConfigured
        false, // squareWebhookConfigured
        undefined, // webhookUrl is undefined
      );
      expect(html).toContain("(configure ALLOWED_DOMAIN first)");
    });

    test("shows square webhook not configured message when key is not set", () => {
      const html = adminSettingsPage(
        TEST_SESSION,
        false,
        "square",
        undefined,
        undefined,
        true,
        false, // squareWebhookConfigured = false
        "https://example.com/payment/webhook",
      );
      expect(html).toContain("No webhook signature key is configured");
      expect(html).toContain("Follow the steps above to set one up");
    });
  });

  describe("adminCalendarPage", () => {
    const calendarAttendee = (overrides: Partial<CalendarAttendeeRow> = {}): CalendarAttendeeRow => ({
      ...testAttendee(),
      eventName: "Daily Event",
      eventDate: "",
      eventLocation: "",
      eventId: 1,
      date: "2026-03-15",
      ...overrides,
    });

    test("renders Calendar title", () => {
      const html = adminCalendarPage([], "localhost", TEST_SESSION, null, []);
      expect(html).toContain("Calendar");
      expect(html).toContain("Attendees by Date");
    });

    test("renders date selector dropdown", () => {
      const dates = [
        { value: "2026-03-15", label: "Sunday 15 March 2026", hasBookings: true },
        { value: "2026-03-16", label: "Monday 16 March 2026", hasBookings: false },
      ];
      const html = adminCalendarPage([], "localhost", TEST_SESSION, null, dates);
      expect(html).toContain("Sunday 15 March 2026");
      expect(html).toContain("Monday 16 March 2026");
      expect(html).toContain("Select a date");
    });

    test("disables options for dates without bookings", () => {
      const dates = [
        { value: "2026-03-15", label: "Sunday 15 March 2026", hasBookings: false },
      ];
      const html = adminCalendarPage([], "localhost", TEST_SESSION, null, dates);
      expect(html).toContain("<option disabled>");
    });

    test("enables options for dates with bookings", () => {
      const dates = [
        { value: "2026-03-15", label: "Sunday 15 March 2026", hasBookings: true },
      ];
      const html = adminCalendarPage([], "localhost", TEST_SESSION, null, dates);
      expect(html).toContain('value="/admin/calendar?date=2026-03-15#attendees"');
    });

    test("shows prompt when no date selected", () => {
      const html = adminCalendarPage([], "localhost", TEST_SESSION, null, []);
      expect(html).toContain("Select a date above to view attendees");
    });

    test("shows no attendees message when date selected but empty", () => {
      const html = adminCalendarPage([], "localhost", TEST_SESSION, "2026-03-15", []);
      expect(html).toContain("No attendees for this date");
    });

    test("shows formatted date label when date is selected", () => {
      const html = adminCalendarPage([], "localhost", TEST_SESSION, "2026-03-15", []);
      expect(html).toContain("Sunday 15 March 2026");
    });

    test("renders attendee rows with event name and link", () => {
      const attendees = [calendarAttendee()];
      const html = adminCalendarPage(attendees, "localhost", TEST_SESSION, "2026-03-15", []);
      expect(html).toContain("Daily Event");
      expect(html).toContain('href="/admin/event/1"');
      expect(html).toContain("John Doe");
    });

    test("renders Event column header", () => {
      const html = adminCalendarPage([], "localhost", TEST_SESSION, null, []);
      expect(html).toContain("<th>Event</th>");
    });

    test("shows CSV export link when date has attendees", () => {
      const attendees = [calendarAttendee()];
      const html = adminCalendarPage(attendees, "localhost", TEST_SESSION, "2026-03-15", []);
      expect(html).toContain('href="/admin/calendar/export?date=2026-03-15"');
      expect(html).toContain("Export CSV");
    });

    test("does not show CSV export when date has no attendees", () => {
      const html = adminCalendarPage([], "localhost", TEST_SESSION, "2026-03-15", []);
      expect(html).not.toContain("Export CSV");
    });

    test("does not show CSV export when no date selected", () => {
      const html = adminCalendarPage([], "localhost", TEST_SESSION, null, []);
      expect(html).not.toContain("Export CSV");
    });

    test("includes Calendar link in admin nav", () => {
      const html = adminCalendarPage([], "localhost", TEST_SESSION, null, []);
      expect(html).toContain('href="/admin/calendar"');
    });

    test("renders empty string for attendee without email", () => {
      const attendees = [calendarAttendee({ email: "" })];
      const html = adminCalendarPage(attendees, "localhost", TEST_SESSION, "2026-03-15", []);
      expect(html).toContain("John Doe");
    });

    test("escapes attendee data", () => {
      const attendees = [calendarAttendee({ name: "<script>evil()</script>" })];
      const html = adminCalendarPage(attendees, "localhost", TEST_SESSION, "2026-03-15", []);
      expect(html).toContain("&lt;script&gt;");
    });
  });

  describe("generateCalendarCsv", () => {
    const calendarAttendee = (overrides: Partial<CalendarAttendeeRow> = {}): CalendarAttendeeRow => ({
      ...testAttendee(),
      eventName: "Daily Event",
      eventDate: "",
      eventLocation: "",
      eventId: 1,
      date: "2026-03-15",
      ...overrides,
    });

    test("generates CSV header for empty attendees (no Event Date/Location columns)", () => {
      const csv = generateCalendarCsv([]);
      expect(csv).toBe("Event,Date,Name,Email,Phone,Address,Special Instructions,Quantity,Registered,Price Paid,Transaction ID,Checked In,Ticket Token,Ticket URL");
    });

    test("omits Event Date and Event Location columns when all empty", () => {
      const attendees = [calendarAttendee()];
      const csv = generateCalendarCsv(attendees);
      const lines = csv.split("\n");
      expect(lines[0]).toContain("Event,Date,Name");
      expect(lines[1]).toMatch(/^Daily Event,2026-03-15,/);
    });

    test("includes Event Date column when some attendees have event dates", () => {
      const attendees = [calendarAttendee({ eventDate: "2026-06-15T14:00:00.000Z" })];
      const csv = generateCalendarCsv(attendees);
      const lines = csv.split("\n");
      expect(lines[0]).toContain("Event,Event Date,Date,Name");
      expect(lines[1]).toContain("2026-06-15T14:00:00.000Z");
    });

    test("includes Event Location column when some attendees have event locations", () => {
      const attendees = [calendarAttendee({ eventLocation: "Village Hall" })];
      const csv = generateCalendarCsv(attendees);
      const lines = csv.split("\n");
      expect(lines[0]).toContain("Event,Event Location,Date,Name");
      expect(lines[1]).toContain("Village Hall");
    });

    test("includes Date column", () => {
      const attendees = [calendarAttendee({ date: "2026-03-20" })];
      const csv = generateCalendarCsv(attendees);
      const lines = csv.split("\n");
      expect(lines[1]).toContain("2026-03-20");
    });

    test("escapes event names with commas", () => {
      const attendees = [calendarAttendee({ eventName: "Event, Special" })];
      const csv = generateCalendarCsv(attendees);
      expect(csv).toContain('"Event, Special"');
    });

    test("includes standard attendee columns", () => {
      const attendees = [calendarAttendee({
        created: "2024-01-15T10:30:00Z",
        quantity: 2,
        price_paid: "2000",
        payment_id: "pi_abc",
        checked_in: "true",
      })];
      const csv = generateCalendarCsv(attendees);
      const lines = csv.split("\n");
      expect(lines[1]).toContain("John Doe");
      expect(lines[1]).toContain("john@example.com");
      expect(lines[1]).toContain(",2,");
      expect(lines[1]).toContain("20.00");
      expect(lines[1]).toContain("pi_abc");
      expect(lines[1]).toContain(",Yes,");
    });

    test("generates multiple rows", () => {
      const attendees = [
        calendarAttendee(),
        calendarAttendee({ id: 2, name: "Jane Smith", eventName: "Other Event" }),
      ];
      const csv = generateCalendarCsv(attendees);
      const lines = csv.split("\n");
      expect(lines).toHaveLength(3);
      expect(lines[1]).toContain("Daily Event");
      expect(lines[2]).toContain("Other Event");
    });

    test("handles null date in calendar row", () => {
      const attendees = [calendarAttendee({ date: null })];
      const csv = generateCalendarCsv(attendees);
      const lines = csv.split("\n");
      // The date column should be empty when null
      expect(lines[1]).toMatch(/^Daily Event,,/);
    });
  });

  describe("admin nav Calendar link", () => {
    test("admin dashboard includes Calendar link in nav", () => {
      const html = adminDashboardPage([], TEST_SESSION, "localhost");
      expect(html).toContain('href="/admin/calendar"');
      expect(html).toContain("Calendar");
    });
  });

  describe("adminEventPage event date and location", () => {
    test("shows Event Date row when event has a date", () => {
      const event = testEventWithCount({ date: "2026-06-15T14:00:00.000Z", attendee_count: 0 });
      const html = adminEventPage({ event, attendees: [], allowedDomain: "localhost", session: TEST_SESSION });
      expect(html).toContain("Event Date");
      expect(html).toContain("Monday 15 June 2026 at 15:00 GMT+1");
    });

    test("does not show Event Date row when date is empty", () => {
      const event = testEventWithCount({ date: "", attendee_count: 0 });
      const html = adminEventPage({ event, attendees: [], allowedDomain: "localhost", session: TEST_SESSION });
      expect(html).not.toContain("Event Date");
    });

    test("shows Location row when event has a location", () => {
      const event = testEventWithCount({ location: "Village Hall", attendee_count: 0 });
      const html = adminEventPage({ event, attendees: [], allowedDomain: "localhost", session: TEST_SESSION });
      expect(html).toContain("<th>Location</th>");
      expect(html).toContain("Village Hall");
    });

    test("does not show Location row when location is empty", () => {
      const event = testEventWithCount({ location: "", attendee_count: 0 });
      const html = adminEventPage({ event, attendees: [], allowedDomain: "localhost", session: TEST_SESSION });
      expect(html).not.toContain("<th>Location</th>");
    });

    test("shows both Event Date and Location when both are set", () => {
      const event = testEventWithCount({
        date: "2026-06-15T14:00:00.000Z",
        location: "Town Centre",
        attendee_count: 0,
      });
      const html = adminEventPage({ event, attendees: [], allowedDomain: "localhost", session: TEST_SESSION });
      expect(html).toContain("Event Date");
      expect(html).toContain("Town Centre");
    });
  });

  describe("adminEventPage edit form pre-fills date and location", () => {
    test("empty date shows no pre-filled value in edit form", () => {
      const event = testEventWithCount({ date: "", attendee_count: 0 });
      const html = adminEventEditPage(event, TEST_SESSION, undefined);
      // The date field should render split date and time inputs
      expect(html).toContain('name="date_date"');
      expect(html).toContain('name="date_time"');
    });

    test("non-empty date shows formatted split values in edit form", () => {
      const event = testEventWithCount({ date: "2026-06-15T14:00:00.000Z", attendee_count: 0 });
      const html = adminEventEditPage(event, TEST_SESSION, undefined);
      // Should contain split date and time values converted to Europe/London (BST = UTC+1)
      expect(html).toContain('value="2026-06-15"');
      expect(html).toContain('value="15:00"');
    });

    test("pre-fills location in edit form", () => {
      const event = testEventWithCount({ location: "Village Hall", attendee_count: 0 });
      const html = adminEventEditPage(event, TEST_SESSION, undefined);
      expect(html).toContain('value="Village Hall"');
    });
  });

  describe("generateAttendeesCsv with eventInfo", () => {
    test("includes Event Date column when eventInfo has non-empty eventDate", () => {
      const eventInfo: CsvEventInfo = { eventDate: "2026-06-15T14:00:00.000Z", eventLocation: "" };
      const csv = generateAttendeesCsv([], false, eventInfo);
      expect(csv).toContain("Event Date,Name");
      expect(csv).not.toContain("Event Location");
    });

    test("includes Event Location column when eventInfo has non-empty eventLocation", () => {
      const eventInfo: CsvEventInfo = { eventDate: "", eventLocation: "Village Hall" };
      const csv = generateAttendeesCsv([], false, eventInfo);
      expect(csv).toContain("Event Location,Name");
      expect(csv).not.toContain("Event Date");
    });

    test("includes both Event Date and Event Location columns", () => {
      const eventInfo: CsvEventInfo = { eventDate: "2026-06-15T14:00:00.000Z", eventLocation: "Village Hall" };
      const csv = generateAttendeesCsv([], false, eventInfo);
      expect(csv).toContain("Event Date,Event Location,Name");
    });

    test("includes event date and location values in rows", () => {
      const eventInfo: CsvEventInfo = { eventDate: "2026-06-15T14:00:00.000Z", eventLocation: "Village Hall" };
      const attendees = [testAttendee()];
      const csv = generateAttendeesCsv(attendees, false, eventInfo);
      const lines = csv.split("\n");
      expect(lines[1]).toContain("2026-06-15T14:00:00.000Z,Village Hall,John Doe");
    });

    test("omits Event Date and Event Location when eventInfo is undefined", () => {
      const csv = generateAttendeesCsv([], false);
      expect(csv).not.toContain("Event Date");
      expect(csv).not.toContain("Event Location");
    });

    test("omits Event Date and Event Location when both are empty", () => {
      const eventInfo: CsvEventInfo = { eventDate: "", eventLocation: "" };
      const csv = generateAttendeesCsv([], false, eventInfo);
      expect(csv).not.toContain("Event Date");
      expect(csv).not.toContain("Event Location");
    });
  });

  describe("datetime validation via eventFields date field", () => {
    const dateField = eventFields.find((f) => f.name === "date")!;

    test("accepts valid datetime value", () => {
      const result = dateField.validate!("2026-06-15T14:00");
      expect(result).toBeNull();
    });

    test("rejects invalid datetime value", () => {
      const result = dateField.validate!("not-a-date");
      expect(result).toBe("Please enter a valid date and time");
    });
  });

  describe("ticketPage event date and location", () => {
    const csrfToken = "test-csrf-token";
    const renderTicket = (
      ev: Parameters<typeof ticketPage>[0],
      opts?: { iframe?: boolean },
    ) => ticketPage(ev, csrfToken, undefined, false, opts?.iframe ?? false, undefined, undefined);

    test("shows date on public ticket page when event has date", () => {
      const event = testEventWithCount({
        date: "2026-06-15T14:00:00.000Z",
        attendee_count: 0,
      });
      const html = renderTicket(event);
      expect(html).toContain("<strong>Date:</strong>");
      expect(html).toContain("Monday 15 June 2026 at 15:00 GMT+1");
    });

    test("does not show date on public ticket page when date is empty", () => {
      const event = testEventWithCount({ date: "", attendee_count: 0 });
      const html = renderTicket(event);
      expect(html).not.toContain("<strong>Date:</strong>");
    });

    test("shows location on public ticket page when event has location", () => {
      const event = testEventWithCount({
        location: "Village Hall",
        attendee_count: 0,
      });
      const html = renderTicket(event);
      expect(html).toContain("<strong>Location:</strong>");
      expect(html).toContain("Village Hall");
    });

    test("does not show location on public ticket page when location is empty", () => {
      const event = testEventWithCount({ location: "", attendee_count: 0 });
      const html = renderTicket(event);
      expect(html).not.toContain("<strong>Location:</strong>");
    });

    test("hides date and location in iframe mode", () => {
      const event = testEventWithCount({
        date: "2026-06-15T14:00:00.000Z",
        location: "Village Hall",
        attendee_count: 0,
      });
      const html = renderTicket(event, { iframe: true });
      expect(html).not.toContain("<strong>Date:</strong>");
      expect(html).not.toContain("<strong>Location:</strong>");
    });
  });

  describe("ticketViewPage event date and location columns", () => {
    const qrSvg = "<svg>test</svg>";

    test("shows Event Date column when entry has non-empty event date", () => {
      const entries = [
        {
          event: testEventWithCount({ date: "2026-06-15T14:00:00.000Z" }),
          attendee: testAttendee(),
        },
      ];
      const html = ticketViewPage(entries, qrSvg);
      expect(html).toContain("<th>Event Date</th>");
      expect(html).toContain("Monday 15 June 2026 at 15:00 GMT+1");
    });

    test("does not show Event Date column when all events have empty date", () => {
      const entries = [
        {
          event: testEventWithCount({ date: "" }),
          attendee: testAttendee(),
        },
      ];
      const html = ticketViewPage(entries, qrSvg);
      expect(html).not.toContain("<th>Event Date</th>");
    });

    test("shows Location column when entry has non-empty location", () => {
      const entries = [
        {
          event: testEventWithCount({ location: "Village Hall" }),
          attendee: testAttendee(),
        },
      ];
      const html = ticketViewPage(entries, qrSvg);
      expect(html).toContain("<th>Location</th>");
      expect(html).toContain("Village Hall");
    });

    test("does not show Location column when all events have empty location", () => {
      const entries = [
        {
          event: testEventWithCount({ location: "" }),
          attendee: testAttendee(),
        },
      ];
      const html = ticketViewPage(entries, qrSvg);
      expect(html).not.toContain("<th>Location</th>");
    });

    test("shows both Event Date and Location columns when both are present", () => {
      const entries = [
        {
          event: testEventWithCount({ date: "2026-06-15T14:00:00.000Z", location: "Town Centre" }),
          attendee: testAttendee(),
        },
      ];
      const html = ticketViewPage(entries, qrSvg);
      expect(html).toContain("<th>Event Date</th>");
      expect(html).toContain("<th>Location</th>");
      expect(html).toContain("Town Centre");
    });

    test("shows empty event date cell when one entry has date and another does not", () => {
      const entries = [
        {
          event: testEventWithCount({ id: 1, date: "2026-06-15T14:00:00.000Z" }),
          attendee: testAttendee({ id: 1 }),
        },
        {
          event: testEventWithCount({ id: 2, date: "" }),
          attendee: testAttendee({ id: 2 }),
        },
      ];
      const html = ticketViewPage(entries, qrSvg);
      expect(html).toContain("<th>Event Date</th>");
      expect(html).toContain("Monday 15 June 2026 at 15:00 GMT+1");
      // The second row should have an empty td for event date
      expect(html).toContain("<td></td>");
    });
  });

  describe("event images", () => {
    const setupStorage = () => {
      Deno.env.set("STORAGE_ZONE_NAME", "testzone");
      Deno.env.set("STORAGE_ZONE_KEY", "testkey");
    };

    const cleanupStorage = () => {
      Deno.env.delete("STORAGE_ZONE_NAME");
      Deno.env.delete("STORAGE_ZONE_KEY");
    };

    describe("renderEventImage", () => {
      test("returns empty string when image_url is null", () => {
        setupStorage();
        const html = renderEventImage({ image_url: "", name: "Test" });
        expect(html).toBe("");
        cleanupStorage();
      });

      test("renders img tag with proxy URL when image_url is set", () => {
        setupStorage();
        const html = renderEventImage({ image_url: "abc123.jpg", name: "Test Event" });
        expect(html).toContain("/image/abc123.jpg");
        expect(html).toContain('alt="Test Event"');
        expect(html).toContain('class="event-image"');
        cleanupStorage();
      });

      test("escapes HTML in event name for alt attribute", () => {
        setupStorage();
        const html = renderEventImage({ image_url: "img.jpg", name: '<script>alert("xss")</script>' });
        expect(html).not.toContain("<script>");
        expect(html).toContain("&lt;script&gt;");
        cleanupStorage();
      });
    });

    describe("ticketPage with image", () => {
      test("shows event image when image_url is set", () => {
        setupStorage();
        const event = testEventWithCount({ image_url: "event-img.jpg" });
        const html = ticketPage(event, TEST_CSRF_TOKEN, undefined, false, false, undefined, null);
        expect(html).toContain("/image/event-img.jpg");
        expect(html).toContain('class="event-image"');
        cleanupStorage();
      });

      test("does not show image when image_url is null", () => {
        setupStorage();
        const event = testEventWithCount({ image_url: "" });
        const html = ticketPage(event, TEST_CSRF_TOKEN, undefined, false, false, undefined, null);
        expect(html).not.toContain("/image/");
        cleanupStorage();
      });

      test("does not show image in iframe mode", () => {
        setupStorage();
        const event = testEventWithCount({ image_url: "event-img.jpg" });
        const html = ticketPage(event, TEST_CSRF_TOKEN, undefined, false, true, undefined, null);
        expect(html).not.toContain("event-img.jpg");
        cleanupStorage();
      });
    });

    describe("multiTicketPage with images", () => {
      test("shows image before each event with image_url", () => {
        setupStorage();
        const events = [
          buildMultiTicketEvent(testEventWithCount({ id: 1, name: "Event A", image_url: "img-a.jpg" })),
          buildMultiTicketEvent(testEventWithCount({ id: 2, name: "Event B", image_url: "img-b.jpg" })),
        ];
        const html = multiTicketPage(events, ["slug-a", "slug-b"], TEST_CSRF_TOKEN);
        expect(html).toContain("/image/img-a.jpg");
        expect(html).toContain("/image/img-b.jpg");
        cleanupStorage();
      });

      test("does not show images when image_url is null", () => {
        setupStorage();
        const events = [
          buildMultiTicketEvent(testEventWithCount({ id: 1, name: "Event A", image_url: "" })),
        ];
        const html = multiTicketPage(events, ["slug-a"], TEST_CSRF_TOKEN);
        expect(html).not.toContain("/image/");
        cleanupStorage();
      });
    });

    describe("ticketViewPage with images", () => {
      const qrSvg = '<svg class="qr"><rect/></svg>';

      test("shows event images when image_url is set", () => {
        setupStorage();
        const entries = [
          {
            event: testEventWithCount({ id: 1, image_url: "ticket-img.jpg" }),
            attendee: testAttendee({ id: 1 }),
          },
        ];
        const html = ticketViewPage(entries, qrSvg);
        expect(html).toContain("/image/ticket-img.jpg");
        cleanupStorage();
      });

      test("does not show images when no event has image_url", () => {
        setupStorage();
        const entries = [
          {
            event: testEventWithCount({ id: 1, image_url: "" }),
            attendee: testAttendee({ id: 1 }),
          },
        ];
        const html = ticketViewPage(entries, qrSvg);
        expect(html).not.toContain("/image/");
        cleanupStorage();
      });
    });

    describe("adminDashboardPage with images", () => {
      test("shows thumbnail when event has image_url", () => {
        setupStorage();
        const events = [testEventWithCount({ image_url: "thumb.jpg" })];
        const html = adminDashboardPage(events, TEST_SESSION, "localhost");
        expect(html).toContain("/image/thumb.jpg");
        expect(html).toContain('class="event-thumbnail"');
        cleanupStorage();
      });

      test("does not show thumbnail when event has no image_url", () => {
        setupStorage();
        const events = [testEventWithCount({ image_url: "" })];
        const html = adminDashboardPage(events, TEST_SESSION, "localhost");
        expect(html).not.toContain('src="/image/');
        cleanupStorage();
      });
    });

    describe("adminEventPage image section", () => {
      test("does not show image upload on detail page", () => {
        setupStorage();
        const event = testEventWithCount({ image_url: "" });
        const html = adminEventPage({ event, attendees: [], allowedDomain: "localhost", session: TEST_SESSION });
        expect(html).not.toContain('type="file"');
        expect(html).not.toContain('name="image"');
        cleanupStorage();
      });
    });

    describe("adminEventEditPage image section", () => {
      test("shows image upload field when storage enabled", () => {
        setupStorage();
        const event = testEventWithCount({ image_url: "" });
        const html = adminEventEditPage(event, TEST_SESSION);
        expect(html).toContain('type="file"');
        expect(html).toContain('name="image"');
        expect(html).toContain("multipart/form-data");
        cleanupStorage();
      });

      test("shows current image and remove button when image is set", () => {
        setupStorage();
        const event = testEventWithCount({ image_url: "current.jpg" });
        const html = adminEventEditPage(event, TEST_SESSION);
        expect(html).toContain("/image/current.jpg");
        expect(html).toContain("Remove Image");
        expect(html).toContain("/image/delete");
        cleanupStorage();
      });

      test("does not show image field when storage is not enabled", () => {
        cleanupStorage();
        const event = testEventWithCount({ image_url: "" });
        const html = adminEventEditPage(event, TEST_SESSION);
        expect(html).not.toContain('type="file"');
        expect(html).not.toContain('name="image"');
      });

      test("shows full-width image preview when event has image", () => {
        setupStorage();
        const event = testEventWithCount({ image_url: "preview.jpg" });
        const html = adminEventEditPage(event, TEST_SESSION);
        expect(html).toContain("event-image-full");
        expect(html).toContain("/image/preview.jpg");
        cleanupStorage();
      });
    });

    describe("adminDuplicateEventPage image section", () => {
      test("shows image upload field when storage enabled", () => {
        setupStorage();
        const event = testEventWithCount({ image_url: "" });
        const html = adminDuplicateEventPage(event, TEST_SESSION);
        expect(html).toContain('type="file"');
        expect(html).toContain('name="image"');
        expect(html).toContain("multipart/form-data");
        cleanupStorage();
      });

      test("does not show image field when storage is not enabled", () => {
        cleanupStorage();
        const event = testEventWithCount({ image_url: "" });
        const html = adminDuplicateEventPage(event, TEST_SESSION);
        expect(html).not.toContain('type="file"');
        expect(html).not.toContain('name="image"');
      });
    });

    describe("adminDashboardPage create form image section", () => {
      test("shows image upload field on create form when storage enabled", () => {
        setupStorage();
        const html = adminDashboardPage([], TEST_SESSION, "localhost");
        expect(html).toContain('type="file"');
        expect(html).toContain('name="image"');
        expect(html).toContain("multipart/form-data");
        cleanupStorage();
      });

      test("does not show image field on create form when storage is not enabled", () => {
        cleanupStorage();
        const html = adminDashboardPage([], TEST_SESSION, "localhost");
        expect(html).not.toContain('type="file"');
      });
    });
  });
});
