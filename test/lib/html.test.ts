import { describe, expect, test } from "#test-compat";
import { adminDashboardPage } from "#templates/admin/dashboard.tsx";
import { adminEventPage } from "#templates/admin/events.tsx";
import { adminLoginPage } from "#templates/admin/login.tsx";
import { generateAttendeesCsv } from "#templates/csv.ts";
import {
  paymentCancelPage,
  paymentErrorPage,
  paymentPage,
  paymentSuccessPage,
} from "#templates/payment.tsx";
import { notFoundPage, ticketPage } from "#templates/public.tsx";
import { testAttendee, testEvent, testEventWithCount } from "#test-utils";

const TEST_CSRF_TOKEN = "test-csrf-token-abc123";

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
      const html = adminDashboardPage([], TEST_CSRF_TOKEN);
      expect(html).toContain("Events");
      expect(html).toContain("No events yet");
    });

    test("renders events table", () => {
      const events = [testEventWithCount({ attendee_count: 25 })];
      const html = adminDashboardPage(events, TEST_CSRF_TOKEN);
      expect(html).toContain("test-event");
      expect(html).toContain("25 / 100");
      expect(html).toContain("/admin/event/1");
    });

    test("displays event slug as identifier", () => {
      const events = [
        testEventWithCount({ slug: "my-test-event", slug_index: "my-test-event-index" }),
      ];
      const html = adminDashboardPage(events, TEST_CSRF_TOKEN);
      expect(html).toContain("my-test-event");
      expect(html).toContain("Identifier");
    });

    test("renders create event form", () => {
      const html = adminDashboardPage([], TEST_CSRF_TOKEN);
      expect(html).toContain("Create New Event");
      expect(html).toContain('name="slug"');
      expect(html).toContain('name="max_attendees"');
      expect(html).toContain('name="thank_you_url"');
    });

    test("includes logout link", () => {
      const html = adminDashboardPage([], TEST_CSRF_TOKEN);
      expect(html).toContain("/admin/logout");
    });
  });

  describe("adminEventPage", () => {
    const event = testEventWithCount({ attendee_count: 2 });

    test("renders event details", () => {
      const html = adminEventPage(event, [], "localhost");
      expect(html).toContain("test-event");
      expect(html).toContain("100");
      expect(html).toContain("https://example.com/thanks");
    });

    test("shows spots remaining", () => {
      const html = adminEventPage(event, [], "localhost");
      expect(html).toContain("98"); // 100 - 2
    });

    test("shows ticket URL", () => {
      const html = adminEventPage(event, [], "localhost");
      expect(html).toContain("/ticket/test-event");
    });

    test("shows embed code with allowed domain", () => {
      const html = adminEventPage(event, [], "example.com");
      expect(html).toContain("Embed Code:");
      expect(html).toContain("https://example.com/ticket/test-event");
      expect(html).toContain("loading=");
      expect(html).toContain("readonly");
    });

    test("renders empty attendees state", () => {
      const html = adminEventPage(event, [], "localhost");
      expect(html).toContain("No attendees yet");
    });

    test("renders attendees table", () => {
      const attendees = [testAttendee()];
      const html = adminEventPage(event, attendees, "localhost");
      expect(html).toContain("John Doe");
      expect(html).toContain("john@example.com");
    });

    test("escapes attendee data", () => {
      const attendees = [testAttendee({ name: "<script>evil()</script>" })];
      const html = adminEventPage(event, attendees, "localhost");
      expect(html).toContain("&lt;script&gt;");
    });

    test("includes back link", () => {
      const html = adminEventPage(event, [], "localhost");
      expect(html).toContain("/admin/");
    });

    test("shows contact fields label", () => {
      const html = adminEventPage(event, [], "localhost");
      expect(html).toContain("Contact Fields");
      expect(html).toContain("Email");
    });

    test("shows phone contact fields label for phone events", () => {
      const html = adminEventPage(
        testEventWithCount({ attendee_count: 2, fields: "phone" }),
        [],
        "localhost",
      );
      expect(html).toContain("Phone Number");
    });

    test("shows both contact fields label", () => {
      const html = adminEventPage(
        testEventWithCount({ attendee_count: 2, fields: "both" }),
        [],
        "localhost",
      );
      expect(html).toContain("Email &amp; Phone Number");
    });

    test("shows phone column in attendee table", () => {
      const html = adminEventPage(event, [], "localhost");
      expect(html).toContain("<th>Phone</th>");
    });

    test("shows attendee phone in table row", () => {
      const attendees = [testAttendee({ phone: "+1 555 123 4567" })];
      const html = adminEventPage(event, attendees, "localhost");
      expect(html).toContain("+1 555 123 4567");
    });
  });

  describe("ticketPage", () => {
    const event = testEventWithCount({ attendee_count: 50 });
    const csrfToken = "test-csrf-token";

    test("renders page title", () => {
      const html = ticketPage(event, csrfToken);
      expect(html).toContain("Reserve Ticket");
    });

    test("renders registration form when spots available", () => {
      const html = ticketPage(event, csrfToken);
      expect(html).toContain('action="/ticket/test-event"');
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

    test("does not display event header content", () => {
      const html = ticketPage(event, csrfToken);
      expect(html).not.toContain("<h1>test-event</h1>");
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
      const html = paymentCancelPage(event, "/ticket/test-event");
      expect(html).toContain("Payment Cancelled");
      expect(html).toContain("/ticket/test-event");
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
      const html = adminDashboardPage([], TEST_CSRF_TOKEN);
      expect(html).toContain('name="unit_price"');
      expect(html).toContain("Ticket Price");
    });
  });

  describe("adminEventPage export button", () => {
    test("renders export CSV button", () => {
      const event = testEventWithCount({ attendee_count: 2 });
      const html = adminEventPage(event, [], "localhost");
      expect(html).toContain("/admin/event/1/export");
      expect(html).toContain("Export CSV");
    });
  });

  describe("generateAttendeesCsv", () => {
    test("generates CSV header for empty attendees", () => {
      const csv = generateAttendeesCsv([]);
      expect(csv).toBe("Name,Email,Phone,Quantity,Registered,Price Paid,Transaction ID");
    });

    test("generates CSV with attendee data", () => {
      const attendees = [
        testAttendee({ created: "2024-01-15T10:30:00Z", quantity: 2 }),
      ];
      const csv = generateAttendeesCsv(attendees);
      const lines = csv.split("\n");
      expect(lines[0]).toBe("Name,Email,Phone,Quantity,Registered,Price Paid,Transaction ID");
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
      expect(lines[0]).toBe("Name,Email,Phone,Quantity,Registered,Price Paid,Transaction ID");
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
      // Price and transaction ID should be empty
      expect(lines[1]).toMatch(/,,$/)
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
  });
});
