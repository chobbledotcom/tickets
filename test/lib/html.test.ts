import { describe, expect, test } from "bun:test";
import type { Attendee, Event, EventWithCount } from "#lib/types.ts";
import { adminDashboardPage } from "#templates/admin/dashboard.tsx";
import { adminEventPage } from "#templates/admin/events.tsx";
import { adminLoginPage } from "#templates/admin/login.tsx";
import { generateAttendeesCsv } from "#templates/csv.ts";
import { layout } from "#templates/layout.tsx";
import {
  paymentCancelPage,
  paymentErrorPage,
  paymentPage,
  paymentSuccessPage,
} from "#templates/payment.tsx";
import { homePage, notFoundPage, ticketPage } from "#templates/public.tsx";

const TEST_CSRF_TOKEN = "test-csrf-token-abc123";

describe("html", () => {
  describe("layout", () => {
    test("wraps content in HTML structure", () => {
      const html = layout("Test Title", "<p>Content</p>");
      expect(html).toContain("<!DOCTYPE html>");
      expect(html).toContain("<title>Test Title</title>");
      expect(html).toContain("<p>Content</p>");
    });

    test("escapes HTML in title", () => {
      const html = layout("<script>alert()</script>", "content");
      expect(html).toContain("&lt;script&gt;");
      expect(html).not.toContain("<script>alert()");
    });

    test("links to MVP.css stylesheet", () => {
      const html = layout("Title", "content");
      expect(html).toContain('<link rel="stylesheet" href="/mvp.css">');
    });
  });

  describe("homePage", () => {
    test("renders home page", () => {
      const html = homePage();
      expect(html).toContain("Ticket Reservation System");
      expect(html).toContain("/admin/");
    });
  });

  describe("adminLoginPage", () => {
    test("renders login form", () => {
      const html = adminLoginPage();
      expect(html).toContain("Admin Login");
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
      expect(html).toContain("Admin Dashboard");
      expect(html).toContain("No events yet");
    });

    test("renders events table", () => {
      const events: EventWithCount[] = [
        {
          id: 1,
          name: "Event 1",
          description: "Desc 1",
          max_attendees: 100,
          thank_you_url: "https://example.com",
          created: "2024-01-01T00:00:00Z",
          attendee_count: 25,
          unit_price: null,
          max_quantity: 1,
          webhook_url: null,
        },
      ];
      const html = adminDashboardPage(events, TEST_CSRF_TOKEN);
      expect(html).toContain("Event 1");
      expect(html).toContain("25 / 100");
      expect(html).toContain("/admin/event/1");
    });

    test("escapes event names", () => {
      const events: EventWithCount[] = [
        {
          id: 1,
          name: "<script>evil()</script>",
          description: "Desc",
          max_attendees: 100,
          thank_you_url: "https://example.com",
          created: "2024-01-01T00:00:00Z",
          attendee_count: 0,
          unit_price: null,
          max_quantity: 1,
          webhook_url: null,
        },
      ];
      const html = adminDashboardPage(events, TEST_CSRF_TOKEN);
      expect(html).toContain("&lt;script&gt;");
    });

    test("renders create event form", () => {
      const html = adminDashboardPage([], TEST_CSRF_TOKEN);
      expect(html).toContain("Create New Event");
      expect(html).toContain('name="name"');
      expect(html).toContain('name="description"');
      expect(html).toContain('name="max_attendees"');
      expect(html).toContain('name="thank_you_url"');
    });

    test("includes logout link", () => {
      const html = adminDashboardPage([], TEST_CSRF_TOKEN);
      expect(html).toContain("/admin/logout");
    });
  });

  describe("adminEventPage", () => {
    const event: EventWithCount = {
      id: 1,
      slug: "test-event",
      name: "Test Event",
      description: "Test Description",
      max_attendees: 100,
      thank_you_url: "https://example.com/thanks",
      created: "2024-01-01T00:00:00Z",
      attendee_count: 2,
      unit_price: null,
      max_quantity: 1,
      webhook_url: null,
    };

    test("renders event details", () => {
      const html = adminEventPage(event, []);
      expect(html).toContain("Test Event");
      expect(html).toContain("Test Description");
      expect(html).toContain("100");
      expect(html).toContain("https://example.com/thanks");
    });

    test("shows spots remaining", () => {
      const html = adminEventPage(event, []);
      expect(html).toContain("98"); // 100 - 2
    });

    test("shows ticket URL", () => {
      const html = adminEventPage(event, []);
      expect(html).toContain("/ticket/test-event");
    });

    test("renders empty attendees state", () => {
      const html = adminEventPage(event, []);
      expect(html).toContain("No attendees yet");
    });

    test("renders attendees table", () => {
      const attendees: Attendee[] = [
        {
          id: 1,
          event_id: 1,
          name: "John Doe",
          email: "john@example.com",
          created: "2024-01-01T12:00:00Z",
          stripe_payment_id: null,
          quantity: 1,
        },
      ];
      const html = adminEventPage(event, attendees);
      expect(html).toContain("John Doe");
      expect(html).toContain("john@example.com");
    });

    test("escapes attendee data", () => {
      const attendees: Attendee[] = [
        {
          id: 1,
          event_id: 1,
          name: "<script>evil()</script>",
          email: "test@example.com",
          created: "2024-01-01T12:00:00Z",
          stripe_payment_id: null,
          quantity: 1,
        },
      ];
      const html = adminEventPage(event, attendees);
      expect(html).toContain("&lt;script&gt;");
    });

    test("includes back link", () => {
      const html = adminEventPage(event, []);
      expect(html).toContain("/admin/");
    });
  });

  describe("ticketPage", () => {
    const event: EventWithCount = {
      id: 1,
      slug: "test-event",
      name: "Test Event",
      description: "Test Description",
      max_attendees: 100,
      thank_you_url: "https://example.com/thanks",
      created: "2024-01-01T00:00:00Z",
      attendee_count: 50,
      unit_price: null,
      max_quantity: 1,
      webhook_url: null,
    };
    const csrfToken = "test-csrf-token";

    test("renders event info", () => {
      const html = ticketPage(event, csrfToken);
      expect(html).toContain("Test Event");
      expect(html).toContain("Test Description");
    });

    test("shows spots remaining", () => {
      const html = ticketPage(event, csrfToken);
      expect(html).toContain("50"); // 100 - 50
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
      const fullEvent: EventWithCount = {
        ...event,
        attendee_count: 100,
      };
      const html = ticketPage(fullEvent, csrfToken);
      expect(html).toContain("this event is full");
      expect(html).not.toContain(">Reserve Ticket</button>");
    });

    test("escapes event data", () => {
      const evilEvent: EventWithCount = {
        ...event,
        name: "<script>evil()</script>",
      };
      const html = ticketPage(evilEvent, csrfToken);
      expect(html).toContain("&lt;script&gt;");
    });

    test("shows quantity selector when max_quantity > 1 and spots available", () => {
      const multiTicketEvent: EventWithCount = {
        ...event,
        max_quantity: 5,
        max_attendees: 100,
        attendee_count: 0,
      };
      const html = ticketPage(multiTicketEvent, csrfToken);
      expect(html).toContain("Number of Tickets");
      expect(html).toContain('name="quantity"');
      expect(html).toContain('<option value="1">1</option>');
      expect(html).toContain('<option value="5">5</option>');
      expect(html).toContain("Reserve Tickets"); // Plural
    });

    test("limits quantity selector to remaining spots", () => {
      const limitedEvent: EventWithCount = {
        ...event,
        max_quantity: 10,
        max_attendees: 100,
        attendee_count: 97, // Only 3 spots remaining
      };
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
  });

  describe("notFoundPage", () => {
    test("renders not found message", () => {
      const html = notFoundPage();
      expect(html).toContain("Not Found");
      expect(html).toContain("doesn't exist");
    });
  });

  describe("paymentPage", () => {
    const event: Event = {
      id: 1,
      slug: "test-event",
      name: "Test Event",
      description: "Test Description",
      max_attendees: 100,
      thank_you_url: "https://example.com/thanks",
      created: "2024-01-01T00:00:00Z",
      unit_price: 1000,
      max_quantity: 1,
      webhook_url: null,
    };

    const attendee: Attendee = {
      id: 1,
      event_id: 1,
      name: "John Doe",
      email: "john@example.com",
      created: "2024-01-01T12:00:00Z",
      stripe_payment_id: null,
      quantity: 1,
    };

    test("renders payment details", () => {
      const html = paymentPage(
        event,
        attendee,
        "https://checkout.stripe.com/session",
        "£10.00",
      );
      expect(html).toContain("Complete Your Payment");
      expect(html).toContain("Test Event");
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
      const evilAttendee: Attendee = {
        ...attendee,
        name: "<script>evil()</script>",
      };
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
    const event: Event = {
      id: 1,
      slug: "test-event",
      name: "Test Event",
      description: "Test Description",
      max_attendees: 100,
      thank_you_url: "https://example.com/thanks",
      created: "2024-01-01T00:00:00Z",
      unit_price: 1000,
      max_quantity: 1,
      webhook_url: null,
    };

    test("renders success message", () => {
      const html = paymentSuccessPage(event, "https://example.com/thanks");
      expect(html).toContain("Payment Successful");
      expect(html).toContain("Test Event");
      expect(html).toContain("https://example.com/thanks");
    });

    test("includes redirect script", () => {
      const html = paymentSuccessPage(event, "https://example.com/thanks");
      expect(html).toContain("setTimeout");
      expect(html).toContain("window.location.href");
    });
  });

  describe("paymentCancelPage", () => {
    const event: Event = {
      id: 1,
      slug: "test-event",
      name: "Test Event",
      description: "Test Description",
      max_attendees: 100,
      thank_you_url: "https://example.com/thanks",
      created: "2024-01-01T00:00:00Z",
      unit_price: 1000,
      max_quantity: 1,
      webhook_url: null,
    };

    test("renders cancel message", () => {
      const html = paymentCancelPage(event, "/ticket/test-event");
      expect(html).toContain("Payment Cancelled");
      expect(html).toContain("Test Event");
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
    const event: EventWithCount = {
      id: 1,
      slug: "test-event",
      name: "Test Event",
      description: "Test Description",
      max_attendees: 100,
      thank_you_url: "https://example.com/thanks",
      created: "2024-01-01T00:00:00Z",
      attendee_count: 2,
      unit_price: null,
      max_quantity: 1,
      webhook_url: null,
    };

    test("renders export CSV button", () => {
      const html = adminEventPage(event, []);
      expect(html).toContain("/admin/event/1/export");
      expect(html).toContain("Export CSV");
    });
  });

  describe("generateAttendeesCsv", () => {
    test("generates CSV header for empty attendees", () => {
      const csv = generateAttendeesCsv([]);
      expect(csv).toBe("Name,Email,Quantity,Registered");
    });

    test("generates CSV with attendee data", () => {
      const attendees: Attendee[] = [
        {
          id: 1,
          event_id: 1,
          name: "John Doe",
          email: "john@example.com",
          created: "2024-01-15T10:30:00Z",
          stripe_payment_id: null,
          quantity: 2,
        },
      ];
      const csv = generateAttendeesCsv(attendees);
      const lines = csv.split("\n");
      expect(lines[0]).toBe("Name,Email,Quantity,Registered");
      expect(lines[1]).toContain("John Doe");
      expect(lines[1]).toContain("john@example.com");
      expect(lines[1]).toContain(",2,");
      expect(lines[1]).toContain("2024-01-15T10:30:00.000Z");
    });

    test("escapes values with commas", () => {
      const attendees: Attendee[] = [
        {
          id: 1,
          event_id: 1,
          name: "Doe, John",
          email: "john@example.com",
          created: "2024-01-15T10:30:00Z",
          stripe_payment_id: null,
          quantity: 1,
        },
      ];
      const csv = generateAttendeesCsv(attendees);
      expect(csv).toContain('"Doe, John"');
    });

    test("escapes values with quotes", () => {
      const attendees: Attendee[] = [
        {
          id: 1,
          event_id: 1,
          name: 'John "JD" Doe',
          email: "john@example.com",
          created: "2024-01-15T10:30:00Z",
          stripe_payment_id: null,
          quantity: 1,
        },
      ];
      const csv = generateAttendeesCsv(attendees);
      expect(csv).toContain('"John ""JD"" Doe"');
    });

    test("escapes values with newlines", () => {
      const attendees: Attendee[] = [
        {
          id: 1,
          event_id: 1,
          name: "John\nDoe",
          email: "john@example.com",
          created: "2024-01-15T10:30:00Z",
          stripe_payment_id: null,
          quantity: 1,
        },
      ];
      const csv = generateAttendeesCsv(attendees);
      expect(csv).toContain('"John\nDoe"');
    });

    test("generates multiple rows", () => {
      const attendees: Attendee[] = [
        {
          id: 1,
          event_id: 1,
          name: "John Doe",
          email: "john@example.com",
          created: "2024-01-15T10:30:00Z",
          stripe_payment_id: null,
          quantity: 1,
        },
        {
          id: 2,
          event_id: 1,
          name: "Jane Smith",
          email: "jane@example.com",
          created: "2024-01-16T11:00:00Z",
          stripe_payment_id: null,
          quantity: 3,
        },
      ];
      const csv = generateAttendeesCsv(attendees);
      const lines = csv.split("\n");
      expect(lines).toHaveLength(3);
      expect(lines[1]).toContain("John Doe");
      expect(lines[2]).toContain("Jane Smith");
    });
  });
});
