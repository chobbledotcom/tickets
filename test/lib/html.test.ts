import { describe, expect, test } from "bun:test";
import {
  adminDashboardPage,
  adminEventPage,
  adminLoginPage,
  homePage,
  layout,
  notFoundPage,
  ticketPage,
} from "#lib/html.ts";
import type { Attendee, EventWithCount } from "#lib/types.ts";

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

    test("includes base styles", () => {
      const html = layout("Title", "content");
      expect(html).toContain("<style>");
      expect(html).toContain("font-family");
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
      const html = adminDashboardPage([]);
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
        },
      ];
      const html = adminDashboardPage(events);
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
        },
      ];
      const html = adminDashboardPage(events);
      expect(html).toContain("&lt;script&gt;");
    });

    test("renders create event form", () => {
      const html = adminDashboardPage([]);
      expect(html).toContain("Create New Event");
      expect(html).toContain('name="name"');
      expect(html).toContain('name="description"');
      expect(html).toContain('name="max_attendees"');
      expect(html).toContain('name="thank_you_url"');
    });

    test("includes logout link", () => {
      const html = adminDashboardPage([]);
      expect(html).toContain("/admin/logout");
    });
  });

  describe("adminEventPage", () => {
    const event: EventWithCount = {
      id: 1,
      name: "Test Event",
      description: "Test Description",
      max_attendees: 100,
      thank_you_url: "https://example.com/thanks",
      created: "2024-01-01T00:00:00Z",
      attendee_count: 2,
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
      expect(html).toContain("/ticket/1");
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
      name: "Test Event",
      description: "Test Description",
      max_attendees: 100,
      thank_you_url: "https://example.com/thanks",
      created: "2024-01-01T00:00:00Z",
      attendee_count: 50,
    };

    test("renders event info", () => {
      const html = ticketPage(event);
      expect(html).toContain("Test Event");
      expect(html).toContain("Test Description");
    });

    test("shows spots remaining", () => {
      const html = ticketPage(event);
      expect(html).toContain("50"); // 100 - 50
    });

    test("renders registration form when spots available", () => {
      const html = ticketPage(event);
      expect(html).toContain('action="/ticket/1"');
      expect(html).toContain('name="name"');
      expect(html).toContain('name="email"');
      expect(html).toContain("Reserve Ticket");
    });

    test("shows error when provided", () => {
      const html = ticketPage(event, "Name and email are required");
      expect(html).toContain("Name and email are required");
      expect(html).toContain('class="error"');
    });

    test("shows full message when no spots", () => {
      const fullEvent: EventWithCount = {
        ...event,
        attendee_count: 100,
      };
      const html = ticketPage(fullEvent);
      expect(html).toContain("this event is full");
      expect(html).not.toContain(">Reserve Ticket</button>");
    });

    test("escapes event data", () => {
      const evilEvent: EventWithCount = {
        ...event,
        name: "<script>evil()</script>",
      };
      const html = ticketPage(evilEvent);
      expect(html).toContain("&lt;script&gt;");
    });
  });

  describe("notFoundPage", () => {
    test("renders not found message", () => {
      const html = notFoundPage();
      expect(html).toContain("Not Found");
      expect(html).toContain("doesn't exist");
    });
  });
});
