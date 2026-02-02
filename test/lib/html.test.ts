import { describe, expect, test } from "#test-compat";
import { CSS_PATH } from "#src/config/asset-paths.ts";
import { adminDashboardPage } from "#templates/admin/dashboard.tsx";
import { adminEventPage, calculateTotalRevenue, nearCapacity } from "#templates/admin/events.tsx";
import { adminLoginPage } from "#templates/admin/login.tsx";
import { adminEventActivityLogPage, adminGlobalActivityLogPage } from "#templates/admin/activityLog.tsx";
import { Breadcrumb } from "#templates/admin/nav.tsx";
import { adminSessionsPage } from "#templates/admin/sessions.tsx";
import { adminSettingsPage } from "#templates/admin/settings.tsx";
import { generateAttendeesCsv } from "#templates/csv.ts";
import {
  paymentCancelPage,
  paymentErrorPage,
  paymentPage,
  paymentSuccessPage,
} from "#templates/payment.tsx";
import { buildMultiTicketEvent, multiTicketPage, notFoundPage, ticketPage } from "#templates/public.tsx";
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
      const html = adminDashboardPage([], TEST_SESSION);
      expect(html).toContain("Events");
      expect(html).toContain("No events yet");
    });

    test("renders events table", () => {
      const events = [testEventWithCount({ attendee_count: 25 })];
      const html = adminDashboardPage(events, TEST_SESSION);
      expect(html).toContain("Test Event");
      expect(html).toContain("25 / 100");
      expect(html).toContain("/admin/event/1");
    });

    test("displays event name", () => {
      const events = [
        testEventWithCount({ name: "My Test Event" }),
      ];
      const html = adminDashboardPage(events, TEST_SESSION);
      expect(html).toContain("My Test Event");
      expect(html).toContain("Event Name");
    });

    test("renders create event form", () => {
      const html = adminDashboardPage([], TEST_SESSION);
      expect(html).toContain("Create New Event");
      expect(html).toContain('name="name"');
      expect(html).toContain('name="max_attendees"');
      expect(html).toContain('name="thank_you_url"');
    });

    test("includes logout link", () => {
      const html = adminDashboardPage([], TEST_SESSION);
      expect(html).toContain("/admin/logout");
    });
  });

  describe("adminEventPage", () => {
    const event = testEventWithCount({ attendee_count: 2 });

    test("renders event name", () => {
      const html = adminEventPage(event, [], "localhost", TEST_SESSION);
      expect(html).toContain("Test Event");
    });

    test("shows attendees row with count and remaining", () => {
      const html = adminEventPage(event, [], "localhost", TEST_SESSION);
      expect(html).toContain("Attendees");
      expect(html).toContain("2 / 100");
      expect(html).toContain("98 remain");
    });

    test("shows thank you URL in copyable input", () => {
      const html = adminEventPage(event, [], "localhost", TEST_SESSION);
      expect(html).toContain("Thank You URL");
      expect(html).toContain('value="https://example.com/thanks"');
      expect(html).toContain("readonly");
      expect(html).toContain("this.select()");
    });

    test("shows public URL with allowed domain", () => {
      const html = adminEventPage(event, [], "example.com", TEST_SESSION);
      expect(html).toContain("Public URL");
      expect(html).toContain('href="https://example.com/ticket/ab12c"');
      expect(html).toContain("example.com/ticket/ab12c");
    });

    test("shows embed code with allowed domain and iframe param", () => {
      const html = adminEventPage(event, [], "example.com", TEST_SESSION);
      expect(html).toContain("Embed Code");
      expect(html).toContain("https://example.com/ticket/ab12c?iframe=true");
      expect(html).toContain("loading=");
      expect(html).toContain("readonly");
    });

    test("embed code uses 18rem height for email-only events", () => {
      const emailEvent = testEventWithCount({ attendee_count: 2, fields: "email" });
      const html = adminEventPage(emailEvent, [], "example.com", TEST_SESSION);
      expect(html).toContain("height: 18rem");
    });

    test("embed code uses 24rem height for both fields events", () => {
      const bothEvent = testEventWithCount({ attendee_count: 2, fields: "both" });
      const html = adminEventPage(bothEvent, [], "example.com", TEST_SESSION);
      expect(html).toContain("height: 24rem");
    });

    test("embed code uses 18rem height for phone-only events", () => {
      const phoneEvent = testEventWithCount({ attendee_count: 2, fields: "phone" });
      const html = adminEventPage(phoneEvent, [], "example.com", TEST_SESSION);
      expect(html).toContain("height: 18rem");
    });

    test("renders empty attendees state", () => {
      const html = adminEventPage(event, [], "localhost", TEST_SESSION);
      expect(html).toContain("No attendees yet");
    });

    test("renders attendees table", () => {
      const attendees = [testAttendee()];
      const html = adminEventPage(event, attendees, "localhost", TEST_SESSION);
      expect(html).toContain("John Doe");
      expect(html).toContain("john@example.com");
    });

    test("escapes attendee data", () => {
      const attendees = [testAttendee({ name: "<script>evil()</script>" })];
      const html = adminEventPage(event, attendees, "localhost", TEST_SESSION);
      expect(html).toContain("&lt;script&gt;");
    });

    test("includes back link", () => {
      const html = adminEventPage(event, [], "localhost", TEST_SESSION);
      expect(html).toContain("/admin/");
    });

    test("shows phone column in attendee table", () => {
      const html = adminEventPage(event, [], "localhost", TEST_SESSION);
      expect(html).toContain("<th>Phone</th>");
    });

    test("shows attendee phone in table row", () => {
      const attendees = [testAttendee({ phone: "+1 555 123 4567" })];
      const html = adminEventPage(event, attendees, "localhost", TEST_SESSION);
      expect(html).toContain("+1 555 123 4567");
    });

    test("renders empty string for attendee without email", () => {
      const attendees = [testAttendee({ email: "" })];
      const html = adminEventPage(event, attendees, "localhost", TEST_SESSION);
      expect(html).toContain("John Doe");
      expect(html).toContain("<td></td>");
    });

    test("shows danger-text class when near capacity", () => {
      const nearFullEvent = testEventWithCount({ attendee_count: 91, max_attendees: 100 });
      const html = adminEventPage(nearFullEvent, [], "localhost", TEST_SESSION);
      expect(html).toContain('class="danger-text"');
      expect(html).toContain("9 remain");
    });

    test("does not show danger-text class when not near capacity", () => {
      const html = adminEventPage(event, [], "localhost", TEST_SESSION);
      expect(html).not.toContain('class="danger-text"');
    });

    test("shows deactivated alert for inactive events", () => {
      const inactive = testEventWithCount({ active: 0, attendee_count: 0 });
      const html = adminEventPage(inactive, [], "localhost", TEST_SESSION);
      expect(html).toContain('class="error"');
      expect(html).toContain("This event is deactivated and cannot be booked");
    });

    test("does not show deactivated alert for active events", () => {
      const html = adminEventPage(event, [], "localhost", TEST_SESSION);
      expect(html).not.toContain("This event is deactivated and cannot be booked");
    });

    test("shows ticket column header", () => {
      const html = adminEventPage(event, [], "localhost", TEST_SESSION);
      expect(html).toContain("<th>Ticket</th>");
    });

    test("shows ticket token as link to public ticket URL", () => {
      const attendees = [testAttendee({ ticket_token: "abc123" })];
      const html = adminEventPage(event, attendees, "mysite.com", TEST_SESSION);
      expect(html).toContain('href="https://mysite.com/t/abc123"');
      expect(html).toContain("abc123");
    });
  });

  describe("ticketPage", () => {
    const event = testEventWithCount({ attendee_count: 50 });
    const csrfToken = "test-csrf-token";

    test("renders page title", () => {
      const html = ticketPage(event, csrfToken);
      expect(html).toContain("Test Event");
    });

    test("renders registration form when spots available", () => {
      const html = ticketPage(event, csrfToken);
      expect(html).toContain('action="/ticket/ab12c"');
      expect(html).toContain('name="name"');
      expect(html).toContain('name="email"');
      expect(html).toContain("Reserve Ticket");
    });

    test("includes CSRF token in form", () => {
      const html = ticketPage(event, csrfToken);
      expect(html).toContain('name="csrf_token"');
      expect(html).toContain(`value="${csrfToken}"`);
    });

    test("shows error when provided", () => {
      const html = ticketPage(event, csrfToken, "Name and email are required");
      expect(html).toContain("Name and email are required");
      expect(html).toContain('class="error"');
    });

    test("shows full message when no spots", () => {
      const fullEvent = testEventWithCount({ attendee_count: 100 });
      const html = ticketPage(fullEvent, csrfToken);
      expect(html).toContain("this event is full");
      expect(html).not.toContain(">Reserve Ticket</button>");
    });

    test("displays event name as header", () => {
      const html = ticketPage(event, csrfToken);
      expect(html).toContain("<h1>Test Event</h1>");
    });

    test("shows quantity selector when max_quantity > 1 and spots available", () => {
      const multiTicketEvent = testEventWithCount({
        max_quantity: 5,
        attendee_count: 0,
      });
      const html = ticketPage(multiTicketEvent, csrfToken);
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
      const html = ticketPage(limitedEvent, csrfToken);
      expect(html).toContain("Number of Tickets");
      expect(html).toContain('<option value="3">3</option>');
      expect(html).not.toContain('<option value="4">4</option>');
    });

    test("hides quantity selector when max_quantity is 1", () => {
      const html = ticketPage(event, csrfToken); // max_quantity is 1
      expect(html).not.toContain("Number of Tickets");
      expect(html).toContain('type="hidden" name="quantity" value="1"');
      expect(html).toContain("Reserve Ticket"); // Singular
      expect(html).not.toContain("Reserve Tickets"); // Not plural
    });

    test("shows phone field for phone-only events", () => {
      const phoneEvent = testEventWithCount({ attendee_count: 50, fields: "phone" });
      const html = ticketPage(phoneEvent, csrfToken);
      expect(html).toContain('name="phone"');
      expect(html).toContain("Your Phone Number");
      expect(html).not.toContain('name="email"');
    });

    test("shows both email and phone for both setting", () => {
      const bothEvent = testEventWithCount({ attendee_count: 50, fields: "both" });
      const html = ticketPage(bothEvent, csrfToken);
      expect(html).toContain('name="email"');
      expect(html).toContain('name="phone"');
    });

    test("shows only email for email setting", () => {
      const html = ticketPage(event, csrfToken);
      expect(html).toContain('name="email"');
      expect(html).not.toContain('name="phone"');
    });

    test("hides header and description in iframe mode", () => {
      const eventWithDesc = testEventWithCount({ attendee_count: 50, description: "A great event" });
      const html = ticketPage(eventWithDesc, csrfToken, undefined, false, true);
      expect(html).not.toContain("<h1>");
      expect(html).not.toContain("A great event");
      expect(html).toContain('class="iframe"');
      expect(html).toContain('name="name"');
    });

    test("shows header and description when not in iframe mode", () => {
      const eventWithDesc = testEventWithCount({ attendee_count: 50, description: "A great event" });
      const html = ticketPage(eventWithDesc, csrfToken, undefined, false, false);
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

    test("includes redirect script", () => {
      const html = paymentSuccessPage(event, "https://example.com/thanks");
      expect(html).toContain("setTimeout");
      expect(html).toContain("window.location.href");
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
      const html = adminDashboardPage([], TEST_SESSION);
      expect(html).toContain('name="unit_price"');
      expect(html).toContain("Ticket Price");
    });
  });

  describe("adminEventPage export button", () => {
    test("renders export CSV button", () => {
      const event = testEventWithCount({ attendee_count: 2 });
      const html = adminEventPage(event, [], "localhost", TEST_SESSION);
      expect(html).toContain("/admin/event/1/export");
      expect(html).toContain("Export CSV");
    });
  });

  describe("generateAttendeesCsv", () => {
    test("generates CSV header for empty attendees", () => {
      const csv = generateAttendeesCsv([]);
      expect(csv).toBe("Name,Email,Phone,Quantity,Registered,Price Paid,Transaction ID,Checked In,Ticket Token,Ticket URL");
    });

    test("generates CSV with attendee data", () => {
      const attendees = [
        testAttendee({ created: "2024-01-15T10:30:00Z", quantity: 2 }),
      ];
      const csv = generateAttendeesCsv(attendees);
      const lines = csv.split("\n");
      expect(lines[0]).toBe("Name,Email,Phone,Quantity,Registered,Price Paid,Transaction ID,Checked In,Ticket Token,Ticket URL");
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
      expect(lines[0]).toBe("Name,Email,Phone,Quantity,Registered,Price Paid,Transaction ID,Checked In,Ticket Token,Ticket URL");
      expect(lines[1]).toContain("+1 555 123 4567");
    });

    test("includes empty phone column when phone not collected", () => {
      const attendees = [testAttendee()];
      const csv = generateAttendeesCsv(attendees);
      const lines = csv.split("\n");
      expect(lines[1]).toContain("john@example.com,,1,");
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
  });

  describe("adminEventPage filter links", () => {
    test("renders All / Checked In / Checked Out links", () => {
      const event = testEventWithCount({ attendee_count: 1 });
      const attendees = [testAttendee()];
      const html = adminEventPage(event, attendees, "localhost", TEST_SESSION);
      expect(html).toContain("All");
      expect(html).toContain("Checked In");
      expect(html).toContain("Checked Out");
    });

    test("bolds All when no filter is active", () => {
      const event = testEventWithCount({ attendee_count: 1 });
      const attendees = [testAttendee()];
      const html = adminEventPage(event, attendees, "localhost", TEST_SESSION);
      expect(html).toContain("<strong>All</strong>");
      expect(html).toContain(`href="/admin/event/${event.id}/in#attendees"`);
      expect(html).toContain(`href="/admin/event/${event.id}/out#attendees"`);
    });

    test("bolds Checked In when filter is in", () => {
      const event = testEventWithCount({ attendee_count: 1 });
      const attendees = [testAttendee()];
      const html = adminEventPage(event, attendees, "localhost", TEST_SESSION, null, "in");
      expect(html).toContain("<strong>Checked In</strong>");
      expect(html).toContain(`href="/admin/event/${event.id}#attendees"`);
    });

    test("bolds Checked Out when filter is out", () => {
      const event = testEventWithCount({ attendee_count: 1 });
      const attendees = [testAttendee()];
      const html = adminEventPage(event, attendees, "localhost", TEST_SESSION, null, "out");
      expect(html).toContain("<strong>Checked Out</strong>");
    });

    test("filters to only checked-in attendees when filter is in", () => {
      const event = testEventWithCount({ attendee_count: 2 });
      const attendees = [
        testAttendee({ id: 1, name: "Checked In User", checked_in: "true" }),
        testAttendee({ id: 2, name: "Not Checked In User", checked_in: "false" }),
      ];
      const html = adminEventPage(event, attendees, "localhost", TEST_SESSION, null, "in");
      expect(html).toContain("Checked In User");
      expect(html).not.toContain("Not Checked In User");
    });

    test("filters to only checked-out attendees when filter is out", () => {
      const event = testEventWithCount({ attendee_count: 2 });
      const attendees = [
        testAttendee({ id: 1, name: "Alice InPerson", checked_in: "true" }),
        testAttendee({ id: 2, name: "Bob Remote", checked_in: "false" }),
      ];
      const html = adminEventPage(event, attendees, "localhost", TEST_SESSION, null, "out");
      expect(html).not.toContain("Alice InPerson");
      expect(html).toContain("Bob Remote");
    });

    test("shows all attendees when filter is all", () => {
      const event = testEventWithCount({ attendee_count: 2 });
      const attendees = [
        testAttendee({ id: 1, name: "Checked In User", checked_in: "true" }),
        testAttendee({ id: 2, name: "Not Checked In User", checked_in: "false" }),
      ];
      const html = adminEventPage(event, attendees, "localhost", TEST_SESSION, null, "all");
      expect(html).toContain("Checked In User");
      expect(html).toContain("Not Checked In User");
    });

    test("includes return_filter hidden field in checkin form", () => {
      const event = testEventWithCount({ attendee_count: 1 });
      const attendees = [testAttendee({ checked_in: "true" })];
      const html = adminEventPage(event, attendees, "localhost", TEST_SESSION, null, "in");
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
      const html = adminDashboardPage(events, TEST_SESSION);
      expect(html).toContain("opacity: 0.5");
      expect(html).toContain("Inactive");
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
      const html = adminEventPage(event, attendees, "localhost", TEST_SESSION);
      expect(html).toContain("Total Revenue");
      expect(html).toContain("30.00");
    });

    test("does not show total revenue for free events", () => {
      const event = testEventWithCount({ unit_price: null, attendee_count: 1 });
      const attendees = [testAttendee()];
      const html = adminEventPage(event, attendees, "localhost", TEST_SESSION);
      expect(html).not.toContain("Total Revenue");
    });

    test("shows 0.00 revenue for paid event with no attendees", () => {
      const event = testEventWithCount({ unit_price: 1000, attendee_count: 0 });
      const html = adminEventPage(event, [], "localhost", TEST_SESSION);
      expect(html).toContain("Total Revenue");
      expect(html).toContain("0.00");
    });
  });

  describe("adminEventPage optional fields", () => {
    test("shows reactivate link for inactive events", () => {
      const event = testEventWithCount({ active: 0, attendee_count: 0 });
      const html = adminEventPage(event, [], "localhost", TEST_SESSION);
      expect(html).toContain("/reactivate");
      expect(html).toContain("Reactivate");
    });

    test("shows simple success message text when no thank_you_url", () => {
      const event = testEventWithCount({ thank_you_url: null, attendee_count: 0 });
      const html = adminEventPage(event, [], "localhost", TEST_SESSION);
      expect(html).toContain("None (shows simple success message)");
    });

    test("shows webhook URL in copyable input when present", () => {
      const event = testEventWithCount({ webhook_url: "https://hooks.example.com/notify", attendee_count: 0 });
      const html = adminEventPage(event, [], "localhost", TEST_SESSION);
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
});
