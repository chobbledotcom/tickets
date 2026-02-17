import { afterEach, beforeEach, describe, expect, spyOn, test } from "#test-compat";
import { updateTermsAndConditions } from "#lib/db/settings.ts";
import { resetStripeClient } from "#lib/stripe.ts";
import { handleRequest } from "#routes";
import { createAttendeeAtomic } from "#lib/db/attendees.ts";
import { addDays } from "#lib/dates.ts";
import { todayInTz } from "#lib/timezone.ts";
import {
  awaitTestRequest,
  createTestDbWithSetup,
  createTestEvent,
  createTestGroup,
  createTestHoliday,
  deactivateTestEvent,
  getTicketCsrfToken,
  mockFormRequest,
  mockRequest,
  resetDb,
  resetTestSlugCounter,
  expectRedirect,
  setupStripe,
  submitTicketForm,
  updateTestEvent,
} from "#test-utils";

const expectReservedRedirectWithTokens = (response: Response): void => {
  expect(response.status).toBe(302);
  const location = response.headers.get("location") || "";
  expect(location).toMatch(/^\/ticket\/reserved\?tokens=.+$/);
};

describe("server (public routes)", () => {
  beforeEach(async () => {
    resetTestSlugCounter();
    await createTestDbWithSetup();
  });

  afterEach(() => {
    resetDb();
  });

  describe("GET /", () => {
    test("redirects to admin", async () => {
      const response = await handleRequest(mockRequest("/"));
      expectRedirect("/admin/")(response);
    });
  });

  describe("GET /health", () => {
    test("returns health status", async () => {
      const response = await handleRequest(mockRequest("/health"));
      expect(response.status).toBe(200);
      const json = await response.json();
      expect(json).toEqual({ status: "ok" });
    });

    test("returns 404 for non-GET requests to /health", async () => {
      const response = await awaitTestRequest("/health", {
        method: "POST",
        data: {},
      });
      expect(response.status).toBe(404);
    });
  });

  describe("GET /favicon.ico", () => {
    test("returns SVG favicon", async () => {
      const response = await handleRequest(mockRequest("/favicon.ico"));
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("image/svg+xml");
      const svg = await response.text();
      expect(svg).toContain("<svg");
      expect(svg).toContain("viewBox");
    });

    test("returns 404 for non-GET requests to /favicon.ico", async () => {
      const response = await awaitTestRequest("/favicon.ico", {
        method: "POST",
        data: {},
      });
      expect(response.status).toBe(404);
    });

    test("has long cache headers", async () => {
      const response = await handleRequest(mockRequest("/favicon.ico"));
      expect(response.headers.get("cache-control")).toBe(
        "public, max-age=31536000, immutable",
      );
    });
  });

  describe("GET /mvp.css", () => {
    test("returns CSS stylesheet", async () => {
      const response = await handleRequest(mockRequest("/mvp.css"));
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe(
        "text/css; charset=utf-8",
      );
      const css = await response.text();
      expect(css).toContain(":root");
      expect(css).toContain("--color-link");
    });

    test("returns 404 for non-GET requests to /mvp.css", async () => {
      const response = await awaitTestRequest("/mvp.css", {
        method: "POST",
        data: {},
      });
      expect(response.status).toBe(404);
    });

    test("has long cache headers", async () => {
      const response = await handleRequest(mockRequest("/mvp.css"));
      expect(response.headers.get("cache-control")).toBe(
        "public, max-age=31536000, immutable",
      );
    });
  });

  describe("GET /admin.js", () => {
    test("returns JavaScript file", async () => {
      const response = await handleRequest(mockRequest("/admin.js"));
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe(
        "application/javascript; charset=utf-8",
      );
      const js = await response.text();
      expect(js).toContain("data-select-on-click");
      expect(js).toContain("data-nav-select");
    });

    test("returns 404 for non-GET requests to /admin.js", async () => {
      const response = await awaitTestRequest("/admin.js", {
        method: "POST",
        data: {},
      });
      expect(response.status).toBe(404);
    });

    test("has long cache headers", async () => {
      const response = await handleRequest(mockRequest("/admin.js"));
      expect(response.headers.get("cache-control")).toBe(
        "public, max-age=31536000, immutable",
      );
    });
  });

  describe("GET /embed.js", () => {
    test("returns JavaScript file", async () => {
      const response = await handleRequest(mockRequest("/embed.js"));
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe(
        "application/javascript; charset=utf-8",
      );
      const js = await response.text();
      expect(js.length).toBeGreaterThan(0);
    });

    test("returns 404 for non-GET requests to /embed.js", async () => {
      const response = await awaitTestRequest("/embed.js", {
        method: "POST",
        data: {},
      });
      expect(response.status).toBe(404);
    });

    test("has long cache headers", async () => {
      const response = await handleRequest(mockRequest("/embed.js"));
      expect(response.headers.get("cache-control")).toBe(
        "public, max-age=31536000, immutable",
      );
    });
  });

  describe("GET /iframe-resizer-parent.js", () => {
    test("returns JavaScript file", async () => {
      const response = await handleRequest(mockRequest("/iframe-resizer-parent.js"));
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe(
        "application/javascript; charset=utf-8",
      );
    });

    test("has long cache headers", async () => {
      const response = await handleRequest(mockRequest("/iframe-resizer-parent.js"));
      expect(response.headers.get("cache-control")).toBe(
        "public, max-age=31536000, immutable",
      );
    });
  });

  describe("GET /iframe-resizer-child.js", () => {
    test("returns JavaScript file", async () => {
      const response = await handleRequest(mockRequest("/iframe-resizer-child.js"));
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe(
        "application/javascript; charset=utf-8",
      );
    });

    test("has long cache headers", async () => {
      const response = await handleRequest(mockRequest("/iframe-resizer-child.js"));
      expect(response.headers.get("cache-control")).toBe(
        "public, max-age=31536000, immutable",
      );
    });
  });

  describe("GET /embed.js", () => {
    test("returns JavaScript file", async () => {
      const response = await handleRequest(mockRequest("/embed.js"));
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe(
        "application/javascript; charset=utf-8",
      );
    });

    test("has long cache headers", async () => {
      const response = await handleRequest(mockRequest("/embed.js"));
      expect(response.headers.get("cache-control")).toBe(
        "public, max-age=31536000, immutable",
      );
    });
  });

  describe("GET /ticket/:slug", () => {
    test("returns 404 for non-existent slug", async () => {
      const response = await handleRequest(mockRequest("/ticket/non-existent"));
      expect(response.status).toBe(404);
    });

    test("shows ticket page for existing event", async () => {
      const event = await createTestEvent({
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });
      const response = await handleRequest(
        mockRequest(`/ticket/${event.slug}`),
      );
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Reserve Ticket");
      expect(html).toContain(`action="/ticket/${event.slug}"`);
    });

    test("shows description when event has one", async () => {
      const event = await createTestEvent({
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
        description: "A <b>great</b> event",
      });
      const response = await handleRequest(
        mockRequest(`/ticket/${event.slug}`),
      );
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("A &lt;b&gt;great&lt;/b&gt; event");
      expect(html).toContain('class="description"');
    });

    test("shows date and location when event has them", async () => {
      const event = await createTestEvent({
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
        date: "2026-06-15T14:00",
        location: "Village Hall",
      });
      const response = await handleRequest(
        mockRequest(`/ticket/${event.slug}`),
      );
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("<strong>Date:</strong>");
      expect(html).toContain("Monday 15 June 2026 at 14:00 UTC");
      expect(html).toContain("<strong>Location:</strong>");
      expect(html).toContain("Village Hall");
    });

    test("does not show date or location when they are empty", async () => {
      const event = await createTestEvent({
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });
      const response = await handleRequest(
        mockRequest(`/ticket/${event.slug}`),
      );
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).not.toContain("<strong>Date:</strong>");
      expect(html).not.toContain("<strong>Location:</strong>");
    });

    test("does not show description div when description is empty", async () => {
      const event = await createTestEvent({
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });
      const response = await handleRequest(
        mockRequest(`/ticket/${event.slug}`),
      );
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).not.toContain("font-size: 0.9em");
    });

    test("returns 404 for inactive event", async () => {
      const event = await createTestEvent({
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });
      // Deactivate the event
      await deactivateTestEvent(event.id);
      const response = await handleRequest(
        mockRequest(`/ticket/${event.slug}`),
      );
      expect(response.status).toBe(404);
      const html = await response.text();
      expect(html).toContain("<h1>Not Found</h1>");
    });

    test("hides header and description in iframe mode", async () => {
      const event = await createTestEvent({
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
        description: "A <b>great</b> event",
      });
      const response = await handleRequest(
        mockRequest(`/ticket/${event.slug}?iframe=true`),
      );
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain('class="iframe"');
      expect(html).not.toContain("<h1>");
      expect(html).not.toContain("A <b>great</b> event");
      expect(html).toContain("Reserve Ticket");
    });

    test("shows header and description without iframe param", async () => {
      const event = await createTestEvent({
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
        description: "A <b>great</b> event",
      });
      const response = await handleRequest(
        mockRequest(`/ticket/${event.slug}`),
      );
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).not.toContain('class="iframe"');
      expect(html).toContain("<h1>");
      expect(html).toContain("A &lt;b&gt;great&lt;/b&gt; event");
    });

    test("does not set CSRF cookies (uses signed tokens instead)", async () => {
      const event = await createTestEvent({ maxAttendees: 50 });
      const response = await handleRequest(
        mockRequest(`/ticket/${event.slug}`),
      );
      const cookie = response.headers.get("set-cookie") || "";
      expect(cookie).not.toContain("csrf_token=");
    });

    test("form action includes ?iframe=true in iframe mode", async () => {
      const event = await createTestEvent({ maxAttendees: 50 });
      const response = await handleRequest(
        mockRequest(`/ticket/${event.slug}?iframe=true`),
      );
      const html = await response.text();
      expect(html).toContain(`action="/ticket/${event.slug}?iframe=true"`);
    });

    test("form action does not include ?iframe=true without iframe param", async () => {
      const event = await createTestEvent({ maxAttendees: 50 });
      const response = await handleRequest(
        mockRequest(`/ticket/${event.slug}`),
      );
      const html = await response.text();
      expect(html).toContain(`action="/ticket/${event.slug}"`);
      expect(html).not.toContain("?iframe=true");
    });

    test("POST with iframe=true succeeds with valid signed CSRF token", async () => {
      const event = await createTestEvent({ maxAttendees: 50 });
      const getResponse = await handleRequest(
        mockRequest(`/ticket/${event.slug}?iframe=true`),
      );
      const csrfToken = getTicketCsrfToken(await getResponse.text());
      expect(csrfToken).not.toBe(null);

      const response = await handleRequest(
        mockFormRequest(
          `/ticket/${event.slug}?iframe=true`,
          { name: "Test User", email: "test@example.com", quantity: "1", csrf_token: csrfToken! },
        ),
      );
      expect(response.status).toBe(302);
    });

    test("CSRF error response does not set cookies in iframe mode", async () => {
      const event = await createTestEvent({ maxAttendees: 50 });
      const response = await handleRequest(
        mockFormRequest(
          `/ticket/${event.slug}?iframe=true`,
          { name: "Test", csrf_token: "wrong-token" },
        ),
      );
      expect(response.status).toBe(403);
      const cookie = response.headers.get("set-cookie") || "";
      expect(cookie).not.toContain("csrf_token=");
    });

    test("GET returns signed CSRF token in form", async () => {
      const event = await createTestEvent({ maxAttendees: 50 });
      const response = await handleRequest(
        mockRequest(`/ticket/${event.slug}?iframe=true`),
      );
      const html = await response.text();
      // Signed tokens start with s1.
      expect(html).toMatch(/name="csrf_token" value="s1\./);
    });

    test("POST succeeds with signed token and no cookie", async () => {
      const event = await createTestEvent({ maxAttendees: 50 });
      // GET the page to obtain the signed token
      const getResponse = await handleRequest(
        mockRequest(`/ticket/${event.slug}`),
      );
      const html = await getResponse.text();
      const match = html.match(/name="csrf_token" value="([^"]+)"/);
      expect(match).not.toBe(null);
      const signedToken = match![1]!;
      expect(signedToken.startsWith("s1.")).toBe(true);

      // POST without any cookie - signed tokens are the only CSRF mechanism
      const response = await handleRequest(
        mockFormRequest(
          `/ticket/${event.slug}`,
          { name: "Test User", email: "test@example.com", quantity: "1", csrf_token: signedToken },
        ),
      );
      expect(response.status).toBe(302);
    });

    test("CSRF error regenerates a signed token", async () => {
      const event = await createTestEvent({ maxAttendees: 50 });
      const response = await handleRequest(
        mockFormRequest(
          `/ticket/${event.slug}?iframe=true`,
          { name: "Test", csrf_token: "wrong-token" },
        ),
      );
      expect(response.status).toBe(403);
      const html = await response.text();
      // The re-rendered form should contain a new signed token
      expect(html).toMatch(/name="csrf_token" value="s1\./);
    });

    test("renders multi-ticket page for group slug", async () => {
      const group = await createTestGroup({ name: "Public Group", slug: "public-group" });
      const event1 = await createTestEvent({ name: "Group Event 1", groupId: group.id, maxAttendees: 50 });
      const event2 = await createTestEvent({ name: "Group Event 2", groupId: group.id, maxAttendees: 50 });

      const response = await handleRequest(mockRequest(`/ticket/${group.slug}`));
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Reserve Tickets");
      expect(html).toContain("Select Tickets");
      expect(html).toContain("Group Event 1");
      expect(html).toContain("Group Event 2");
      expect(html).toContain(`action="/ticket/${group.slug}"`);
      expect(html).toContain(`quantity_${event1.id}`);
      expect(html).toContain(`quantity_${event2.id}`);
    });

    test("returns 404 when group has no active events", async () => {
      const group = await createTestGroup({ name: "Empty Group", slug: "empty-group" });
      const event = await createTestEvent({ name: "Inactive In Group", groupId: group.id, maxAttendees: 50 });
      await deactivateTestEvent(event.id);

      const response = await handleRequest(mockRequest(`/ticket/${group.slug}`));
      expect(response.status).toBe(404);
    });

    test("group terms override global terms", async () => {
      await updateTermsAndConditions("GLOBAL TERMS UNIQUE");
      const group = await createTestGroup({
        name: "Terms Group",
        slug: "terms-group",
        termsAndConditions: "GROUP TERMS UNIQUE",
      });
      await createTestEvent({ name: "Terms Event", groupId: group.id, maxAttendees: 50 });

      const response = await handleRequest(mockRequest(`/ticket/${group.slug}`));
      const html = await response.text();
      expect(html).toContain("GROUP TERMS UNIQUE");
      expect(html).not.toContain("GLOBAL TERMS UNIQUE");
    });

    test("group terms fall back to global when group terms are empty", async () => {
      await updateTermsAndConditions("GLOBAL FALLBACK UNIQUE");
      const group = await createTestGroup({ name: "Fallback Group", slug: "fallback-group", termsAndConditions: "" });
      await createTestEvent({ name: "Fallback Event", groupId: group.id, maxAttendees: 50 });

      const response = await handleRequest(mockRequest(`/ticket/${group.slug}`));
      const html = await response.text();
      expect(html).toContain("GLOBAL FALLBACK UNIQUE");
    });

    test("group page shows shared date selector for daily events", async () => {
      const group = await createTestGroup({ name: "Daily Group", slug: "daily-group" });
      await createTestEvent({
        name: "Daily A",
        groupId: group.id,
        maxAttendees: 10,
        eventType: "daily",
        bookableDays: JSON.stringify(["Monday"]),
        minimumDaysBefore: 0,
        maximumDaysAfter: 14,
      });
      await createTestEvent({
        name: "Daily B",
        groupId: group.id,
        maxAttendees: 10,
        eventType: "daily",
        bookableDays: JSON.stringify(["Monday", "Tuesday"]),
        minimumDaysBefore: 0,
        maximumDaysAfter: 14,
      });

      const response = await handleRequest(mockRequest(`/ticket/${group.slug}`));
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Select Date");
      expect(html).toContain('name="date"');
    });
  });

  describe("POST /ticket/:slug", () => {
    test("returns 404 for non-existent slug", async () => {
      const response = await handleRequest(
        mockFormRequest("/ticket/non-existent", {
          name: "John",
          email: "john@example.com",
        }),
      );
      expect(response.status).toBe(404);
    });

    test("processes registration for group slug", async () => {
      const group = await createTestGroup({ name: "Post Group", slug: "post-group" });
      const event1 = await createTestEvent({ name: "Post Group Event 1", groupId: group.id, maxAttendees: 50, maxQuantity: 5 });
      const event2 = await createTestEvent({ name: "Post Group Event 2", groupId: group.id, maxAttendees: 50, maxQuantity: 5 });

      const getResponse = await handleRequest(mockRequest(`/ticket/${group.slug}`));
      const csrfToken = getTicketCsrfToken(await getResponse.text());
      if (!csrfToken) throw new Error("Failed to get CSRF token");

      const response = await handleRequest(
        mockFormRequest(
          `/ticket/${group.slug}`,
          {
            name: "Group User",
            email: "group@example.com",
            [`quantity_${event1.id}`]: "1",
            [`quantity_${event2.id}`]: "2",
            csrf_token: csrfToken,
          },
          `csrf_token=${csrfToken}`,
        ),
      );
      expectReservedRedirectWithTokens(response);

      const { getAttendeesRaw } = await import("#lib/db/attendees.ts");
      const attendees1 = await getAttendeesRaw(event1.id);
      const attendees2 = await getAttendeesRaw(event2.id);
      expect(attendees1.length).toBe(1);
      expect(attendees1[0]?.quantity).toBe(1);
      expect(attendees2.length).toBe(1);
      expect(attendees2[0]?.quantity).toBe(2);
    });

    test("returns 404 for inactive event", async () => {
      const event = await createTestEvent({
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });
      // Deactivate the event
      await deactivateTestEvent(event.id);
      const response = await handleRequest(
        mockFormRequest(`/ticket/${event.slug}`, {
          name: "John",
          email: "john@example.com",
        }),
      );
      expect(response.status).toBe(404);
    });

    test("rejects request without CSRF token", async () => {
      const event = await createTestEvent({
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });
      const response = await handleRequest(
        mockFormRequest(`/ticket/${event.slug}`, {
          name: "John",
          email: "john@example.com",
        }),
      );
      expect(response.status).toBe(403);
      const html = await response.text();
      expect(html).toContain("Invalid or expired form");
    });

    test("validates required fields", async () => {
      const event = await createTestEvent({
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });
      const response = await submitTicketForm(event.slug, {
        name: "",
        email: "",
      });
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("Your Name is required");
    });

    test("validates name is required", async () => {
      const event = await createTestEvent({
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });
      const response = await submitTicketForm(event.slug, {
        name: "   ",
        email: "john@example.com",
      });
      expect(response.status).toBe(400);
    });

    test("validates email is required", async () => {
      const event = await createTestEvent({
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });
      const response = await submitTicketForm(event.slug, {
        name: "John",
        email: "   ",
      });
      expect(response.status).toBe(400);
    });

    test("creates attendee and redirects to thank you page", async () => {
      const event = await createTestEvent({
        maxAttendees: 50,
        thankYouUrl: "https://example.com/thanks",
      });
      const response = await submitTicketForm(event.slug, {
        name: "John Doe",
        email: "john@example.com",
      });
      expectRedirect("https://example.com/thanks")(response);
    });

    test("rejects when event is full", async () => {
      const event = await createTestEvent({
        maxAttendees: 1,
        thankYouUrl: "https://example.com",
      });
      await submitTicketForm(event.slug, {
        name: "John",
        email: "john@example.com",
      });

      const response = await submitTicketForm(event.slug, {
        name: "Jane",
        email: "jane@example.com",
      });
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("not enough spots available");
    });

    test("returns 404 for unsupported method on ticket route", async () => {
      const event = await createTestEvent({
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });
      const response = await awaitTestRequest(`/ticket/${event.slug}`, {
        method: "PUT",
      });
      expect(response.status).toBe(404);
    });
  });

  describe("GET /ticket/:slug1+:slug2 (multi-ticket)", () => {
    test("returns 404 when no valid events", async () => {
      const response = await handleRequest(
        mockRequest("/ticket/nonexistent1+nonexistent2"),
      );
      expect(response.status).toBe(404);
    });

    test("shows multi-ticket page for multiple existing events", async () => {
      const event1 = await createTestEvent({
        name: "Multi Event 1",
        maxAttendees: 50,
      });
      const event2 = await createTestEvent({
        name: "Multi Event 2",
        maxAttendees: 100,
      });
      const response = await handleRequest(
        mockRequest(`/ticket/${event1.slug}+${event2.slug}`),
      );
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Reserve Tickets");
      expect(html).toContain("Multi Event 1");
      expect(html).toContain("Multi Event 2");
      expect(html).toContain("Select Tickets");
    });

    test("shows description beneath each event in multi-ticket page", async () => {
      const event1 = await createTestEvent({
        name: "Multi Desc 1",
        maxAttendees: 50,
        description: "First event info",
      });
      const event2 = await createTestEvent({
        name: "Multi Desc 2",
        maxAttendees: 100,
        description: "Second event info",
      });
      const response = await handleRequest(
        mockRequest(`/ticket/${event1.slug}+${event2.slug}`),
      );
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("First event info");
      expect(html).toContain("Second event info");
    });

    test("omits description div in multi-ticket when description is empty", async () => {
      const event1 = await createTestEvent({
        name: "Multi No Desc",
        maxAttendees: 50,
      });
      const event2 = await createTestEvent({
        name: "Multi No Desc 2",
        maxAttendees: 100,
      });
      const response = await handleRequest(
        mockRequest(`/ticket/${event1.slug}+${event2.slug}`),
      );
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Multi No Desc");
      expect(html).not.toContain("margin: 0.25rem 0 0.5rem");
    });

    test("shows sold-out label for full events", async () => {
      const event1 = await createTestEvent({
        name: "Multi Available",
        maxAttendees: 50,
      });
      const event2 = await createTestEvent({
        name: "Multi Full",
        maxAttendees: 1,
      });
      // Fill up event2
      await createAttendeeAtomic({ eventId: event2.id, name: "John", email: "john@example.com", quantity: 1 });

      const response = await handleRequest(
        mockRequest(`/ticket/${event1.slug}+${event2.slug}`),
      );
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Sold Out");
    });

    test("shows description for sold-out event in multi-ticket page", async () => {
      const event1 = await createTestEvent({
        name: "Multi Avail Desc",
        maxAttendees: 50,
        description: "Available desc",
      });
      const event2 = await createTestEvent({
        name: "Multi Full Desc",
        maxAttendees: 1,
        description: "Sold out desc",
      });
      await createAttendeeAtomic({ eventId: event2.id, name: "Jane", email: "jane@example.com", quantity: 1 });

      const response = await handleRequest(
        mockRequest(`/ticket/${event1.slug}+${event2.slug}`),
      );
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Available desc");
      expect(html).toContain("Sold out desc");
      expect(html).toContain("Sold Out");
    });

    test("filters out inactive events", async () => {
      const event1 = await createTestEvent({
        name: "Multi Active",
        maxAttendees: 50,
      });
      const event2 = await createTestEvent({
        name: "Multi Inactive",
        maxAttendees: 50,
      });
      await deactivateTestEvent(event2.id);

      const response = await handleRequest(
        mockRequest(`/ticket/${event1.slug}+${event2.slug}`),
      );
      expect(response.status).toBe(200);
      const html = await response.text();
      // The active event should have a quantity selector
      expect(html).toContain(`quantity_${event1.id}`);
      // The inactive event should not have a quantity selector
      expect(html).not.toContain(`quantity_${event2.id}`);
    });

    test("returns 404 when all events are inactive", async () => {
      const event1 = await createTestEvent({
        name: "All Inactive 1",
        maxAttendees: 50,
      });
      const event2 = await createTestEvent({
        name: "All Inactive 2",
        maxAttendees: 50,
      });
      await deactivateTestEvent(event1.id);
      await deactivateTestEvent(event2.id);

      const response = await handleRequest(
        mockRequest(`/ticket/${event1.slug}+${event2.slug}`),
      );
      expect(response.status).toBe(404);
    });

    test("does not set CSRF cookies for multi-ticket (uses signed tokens)", async () => {
      const event1 = await createTestEvent({ maxAttendees: 50 });
      const event2 = await createTestEvent({ maxAttendees: 50 });
      const response = await handleRequest(
        mockRequest(`/ticket/${event1.slug}+${event2.slug}`),
      );
      const cookie = response.headers.get("set-cookie") || "";
      expect(cookie).not.toContain("csrf_token=");
    });

    test("form action includes ?iframe=true in iframe mode", async () => {
      const event1 = await createTestEvent({ maxAttendees: 50 });
      const event2 = await createTestEvent({ maxAttendees: 50 });
      const response = await handleRequest(
        mockRequest(`/ticket/${event1.slug}+${event2.slug}?iframe=true`),
      );
      const html = await response.text();
      expect(html).toContain(`action="/ticket/${event1.slug}+${event2.slug}?iframe=true"`);
    });

    test("multi-ticket GET returns signed CSRF token in form", async () => {
      const event1 = await createTestEvent({ maxAttendees: 50 });
      const event2 = await createTestEvent({ maxAttendees: 50 });
      const response = await handleRequest(
        mockRequest(`/ticket/${event1.slug}+${event2.slug}?iframe=true`),
      );
      const html = await response.text();
      expect(html).toMatch(/name="csrf_token" value="s1\./);
    });

    test("multi-ticket POST succeeds with signed token and no cookie", async () => {
      const event1 = await createTestEvent({ maxAttendees: 50 });
      const event2 = await createTestEvent({ maxAttendees: 50 });
      const path = `/ticket/${event1.slug}+${event2.slug}`;

      const getResponse = await handleRequest(
        mockRequest(`${path}?iframe=true`),
      );
      const html = await getResponse.text();
      const match = html.match(/name="csrf_token" value="([^"]+)"/);
      expect(match).not.toBe(null);
      const signedToken = match![1]!;

      const response = await handleRequest(
        mockFormRequest(
          `${path}?iframe=true`,
          {
            name: "Test User",
            email: "test@example.com",
            [`quantity_${event1.id}`]: "1",
            [`quantity_${event2.id}`]: "1",
            csrf_token: signedToken,
          },
        ),
      );
      expect(response.status).toBe(302);
    });
  });

  describe("POST /ticket/:slug1+:slug2 (multi-ticket)", () => {
    /** Helper to submit multi-ticket form with CSRF */
    const submitMultiTicketForm = async (
      slugs: string[],
      data: Record<string, string>,
    ): Promise<Response> => {
      const path = `/ticket/${slugs.join("+")}`;
      const getResponse = await handleRequest(mockRequest(path));
      const csrfToken = getTicketCsrfToken(await getResponse.text());
      if (!csrfToken) throw new Error("Failed to get CSRF token");

      return handleRequest(
        mockFormRequest(path, { ...data, csrf_token: csrfToken }),
      );
    };

    test("returns 404 when no valid events", async () => {
      const response = await handleRequest(
        mockFormRequest("/ticket/nonexistent1+nonexistent2", {
          name: "John",
          email: "john@example.com",
        }),
      );
      expect(response.status).toBe(404);
    });

    test("validates name is required", async () => {
      const event1 = await createTestEvent({
        name: "Post Multi 1",
        maxAttendees: 50,
      });
      const event2 = await createTestEvent({
        name: "Post Multi 2",
        maxAttendees: 50,
      });
      const response = await submitMultiTicketForm([event1.slug, event2.slug], {
        name: "",
        email: "john@example.com",
        [`quantity_${event1.id}`]: "1",
      });
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("required");
    });

    test("requires at least one ticket selected", async () => {
      const event1 = await createTestEvent({
        name: "Post Multi Empty 1",
        maxAttendees: 50,
      });
      const event2 = await createTestEvent({
        name: "Post Multi Empty 2",
        maxAttendees: 50,
      });
      const response = await submitMultiTicketForm([event1.slug, event2.slug], {
        name: "John Doe",
        email: "john@example.com",
        [`quantity_${event1.id}`]: "0",
        [`quantity_${event2.id}`]: "0",
      });
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("Please select at least one ticket");
    });

    test("creates attendees for selected free events", async () => {
      const event1 = await createTestEvent({
        name: "Post Multi Free 1",
        maxAttendees: 50,
        maxQuantity: 5,
      });
      const event2 = await createTestEvent({
        name: "Post Multi Free 2",
        maxAttendees: 50,
        maxQuantity: 5,
      });
      const response = await submitMultiTicketForm([event1.slug, event2.slug], {
        name: "John Doe",
        email: "john@example.com",
        [`quantity_${event1.id}`]: "2",
        [`quantity_${event2.id}`]: "1",
      });
      expectReservedRedirectWithTokens(response);

      // Verify attendees were created
      const { getAttendeesRaw } = await import("#lib/db/attendees.ts");
      const attendees1 = await getAttendeesRaw(event1.id);
      const attendees2 = await getAttendeesRaw(event2.id);
      expect(attendees1.length).toBe(1);
      expect(attendees1[0]?.quantity).toBe(2);
      expect(attendees2.length).toBe(1);
      expect(attendees2[0]?.quantity).toBe(1);
    });

    test("only registers for events with quantity > 0", async () => {
      const event1 = await createTestEvent({
        name: "Post Multi Partial 1",
        maxAttendees: 50,
      });
      const event2 = await createTestEvent({
        name: "Post Multi Partial 2",
        maxAttendees: 50,
      });
      const response = await submitMultiTicketForm([event1.slug, event2.slug], {
        name: "John Doe",
        email: "john@example.com",
        [`quantity_${event1.id}`]: "1",
        [`quantity_${event2.id}`]: "0",
      });
      expectReservedRedirectWithTokens(response);

      // Verify only event1 has an attendee
      const { getAttendeesRaw } = await import("#lib/db/attendees.ts");
      const attendees1 = await getAttendeesRaw(event1.id);
      const attendees2 = await getAttendeesRaw(event2.id);
      expect(attendees1.length).toBe(1);
      expect(attendees2.length).toBe(0);
    });

    test("caps quantity at max purchasable", async () => {
      const event1 = await createTestEvent({
        name: "Post Multi Cap 1",
        maxAttendees: 3,
        maxQuantity: 2,
      });
      const event2 = await createTestEvent({
        name: "Post Multi Cap 2",
        maxAttendees: 50,
        maxQuantity: 5,
      });
      const response = await submitMultiTicketForm([event1.slug, event2.slug], {
        name: "John Doe",
        email: "john@example.com",
        [`quantity_${event1.id}`]: "10", // Request more than max
        [`quantity_${event2.id}`]: "0",
      });
      expectReservedRedirectWithTokens(response);

      // Verify quantity was capped
      const { getAttendeesRaw } = await import("#lib/db/attendees.ts");
      const attendees = await getAttendeesRaw(event1.id);
      expect(attendees.length).toBe(1);
      expect(attendees[0]?.quantity).toBe(2); // Capped at maxQuantity
    });
  });

  describe("404 handling", () => {
    test("returns 404 for unknown routes", async () => {
      const response = await handleRequest(mockRequest("/unknown/path"));
      expect(response.status).toBe(404);
    });
  });

  describe("GET /ticket/reserved", () => {
    test("shows reservation success page", async () => {
      const response = await handleRequest(mockRequest("/ticket/reserved"));
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("success");
      expect(html).not.toContain("view your tickets");
    });

    test("shows ticket link when tokens are provided", async () => {
      const response = await handleRequest(mockRequest("/ticket/reserved?tokens=abc123+def456"));
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain('href="/t/abc123+def456"');
      expect(html).toContain("Click here to view your tickets");
    });

    test("includes iframe-resizer child script when iframe=true", async () => {
      const response = await handleRequest(mockRequest("/ticket/reserved?tokens=abc123&iframe=true"));
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("iframe-resizer-child.js");
      expect(html).toContain('class="iframe"');
    });

    test("excludes iframe-resizer child script without iframe param", async () => {
      const response = await handleRequest(mockRequest("/ticket/reserved?tokens=abc123"));
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).not.toContain("iframe-resizer-child.js");
    });
  });

  describe("POST /ticket/:slug (free event without thank_you_url)", () => {
    test("shows inline success page when no thank_you_url", async () => {
      const event = await createTestEvent({
        maxAttendees: 50,
        thankYouUrl: "", // No thank_you_url
      });

      const response = await submitTicketForm(event.slug, {
        name: "John Doe",
        email: "john@example.com",
      });
      // Should redirect to success page
      expectReservedRedirectWithTokens(response);
    });

    test("propagates iframe=true in redirect to reserved page", async () => {
      const event = await createTestEvent({
        maxAttendees: 50,
        thankYouUrl: "",
      });

      const getResponse = await handleRequest(
        mockRequest(`/ticket/${event.slug}?iframe=true`),
      );
      const csrfToken = getTicketCsrfToken(await getResponse.text());
      expect(csrfToken).not.toBe(null);

      const response = await handleRequest(
        mockFormRequest(
          `/ticket/${event.slug}?iframe=true`,
          { name: "Jane Doe", email: "jane@example.com", quantity: "1", csrf_token: csrfToken! },
        ),
      );
      expect(response.status).toBe(302);
      const location = response.headers.get("location") || "";
      expect(location).toContain("/ticket/reserved");
      expect(location).toContain("iframe=true");
    });
  });

  describe("multi-ticket paid flow", () => {
    afterEach(() => {
      resetStripeClient();
    });

    test("redirects to checkout for multi-ticket paid events", async () => {
      await setupStripe();

      const event1 = await createTestEvent({
        name: "Multi Paid 1",
        maxAttendees: 50,
        unitPrice: 500,
        maxQuantity: 5,
      });
      const event2 = await createTestEvent({
        name: "Multi Paid 2",
        maxAttendees: 50,
        unitPrice: 1000,
        maxQuantity: 5,
      });

      const path = `/ticket/${event1.slug}+${event2.slug}`;
      const getResponse = await handleRequest(mockRequest(path));
      const csrfToken = getTicketCsrfToken(await getResponse.text());
      if (!csrfToken) throw new Error("Failed to get CSRF token");

      const response = await handleRequest(
        mockFormRequest(
          path,
          {
            name: "John Doe",
            email: "john@example.com",
            [`quantity_${event1.id}`]: "1",
            [`quantity_${event2.id}`]: "2",
            csrf_token: csrfToken,
          },
          `csrf_token=${csrfToken}`,
        ),
      );

      // Should redirect to Stripe checkout
      expect(response.status).toBe(302);
      const location = response.headers.get("location");
      expect(location).not.toBeNull();
      expect(location?.startsWith("https://")).toBe(true);
    });

    test("shows error when no tickets selected in multi-ticket paid form", async () => {
      await setupStripe();

      const event1 = await createTestEvent({
        name: "Multi Nosel 1",
        maxAttendees: 50,
        unitPrice: 500,
        maxQuantity: 5,
      });
      const event2 = await createTestEvent({
        name: "Multi Nosel 2",
        maxAttendees: 50,
        unitPrice: 1000,
        maxQuantity: 5,
      });

      const path = `/ticket/${event1.slug}+${event2.slug}`;
      const getResponse = await handleRequest(mockRequest(path));
      const csrfToken = getTicketCsrfToken(await getResponse.text());
      if (!csrfToken) throw new Error("Failed to get CSRF token");

      // Submit with all quantities at 0
      const response = await handleRequest(
        mockFormRequest(
          path,
          {
            name: "John Doe",
            email: "john@example.com",
            [`quantity_${event1.id}`]: "0",
            [`quantity_${event2.id}`]: "0",
            csrf_token: csrfToken,
          },
          `csrf_token=${csrfToken}`,
        ),
      );

      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("Please select at least one ticket");
    });
  });

  describe("multi-ticket free flow (capacity exceeded)", () => {
    test("shows error when free multi-ticket atomic create fails capacity", async () => {
      const event1 = await createTestEvent({
        name: "Multi Free Cap 1",
        maxAttendees: 50,
        maxQuantity: 5,
      });
      const event2 = await createTestEvent({
        name: "Multi Free Cap 2",
        maxAttendees: 50,
        maxQuantity: 5,
      });

      const path = `/ticket/${event1.slug}+${event2.slug}`;
      const getResponse = await handleRequest(mockRequest(path));
      const csrfToken = getTicketCsrfToken(await getResponse.text());
      if (!csrfToken) throw new Error("Failed to get CSRF token");

      // Mock atomic create to fail on second call (simulates race condition)
      const { attendeesApi } = await import("#lib/db/attendees.ts");
      const origCreate = attendeesApi.createAttendeeAtomic;
      let callCount = 0;
      const mockCreate = spyOn(attendeesApi, "createAttendeeAtomic");
      mockCreate.mockImplementation((...args: Parameters<typeof origCreate>) => {
        callCount++;
        if (callCount === 2) {
          return Promise.resolve({ success: false as const, reason: "capacity_exceeded" as const });
        }
        return origCreate(...args);
      });

      try {
        const response = await handleRequest(
          mockFormRequest(
            path,
            {
              name: "John Doe",
              email: "john@example.com",
              [`quantity_${event1.id}`]: "1",
              [`quantity_${event2.id}`]: "1",
              csrf_token: csrfToken,
            },
            `csrf_token=${csrfToken}`,
          ),
        );

        expect(response.status).toBe(400);
        const html = await response.text();
        expect(html).toContain("no longer has enough spots");
      } finally {
        mockCreate.mockRestore();
      }
    });

    test("multi-ticket free registration succeeds for both events", async () => {
      const event1 = await createTestEvent({
        name: "Multi Free Ok 1",
        maxAttendees: 50,
        maxQuantity: 5,
      });
      const event2 = await createTestEvent({
        name: "Multi Free Ok 2",
        maxAttendees: 50,
        maxQuantity: 5,
      });

      const path = `/ticket/${event1.slug}+${event2.slug}`;
      const getResponse = await handleRequest(mockRequest(path));
      const csrfToken = getTicketCsrfToken(await getResponse.text());
      if (!csrfToken) throw new Error("Failed to get CSRF token");

      const response = await handleRequest(
        mockFormRequest(
          path,
          {
            name: "Multi Free User",
            email: "multifree@example.com",
            [`quantity_${event1.id}`]: "2",
            [`quantity_${event2.id}`]: "1",
            csrf_token: csrfToken,
          },
          `csrf_token=${csrfToken}`,
        ),
      );

      expectReservedRedirectWithTokens(response);

      // Verify attendees created for both events
      const { getAttendeesRaw } = await import("#lib/db/attendees.ts");
      const attendees1 = await getAttendeesRaw(event1.id);
      const attendees2 = await getAttendeesRaw(event2.id);
      expect(attendees1.length).toBe(1);
      expect(attendees1[0]?.quantity).toBe(2);
      expect(attendees2.length).toBe(1);
      expect(attendees2[0]?.quantity).toBe(1);
    });
  });

  describe("POST /ticket/:slug1+:slug2 (unsupported method)", () => {
    test("returns 404 for PUT on multi-ticket route", async () => {
      const event1 = await createTestEvent({
        name: "Multi Put 1",
        maxAttendees: 50,
      });
      const event2 = await createTestEvent({
        name: "Multi Put 2",
        maxAttendees: 50,
      });
      const response = await awaitTestRequest(
        `/ticket/${event1.slug}+${event2.slug}`,
        { method: "PUT" },
      );
      expect(response.status).toBe(404);
    });
  });

  describe("routes/public.ts (additional coverage)", () => {
    test("ticket form with phone-only fields (no email field) works", async () => {
      const event = await createTestEvent({
        maxAttendees: 50,
        thankYouUrl: "https://example.com/thanks",
        fields: "phone",
      });

      const response = await submitTicketForm(event.slug, {
        name: "John Doe",
        phone: "555-1234",
      });
      // With fields="phone", email is not collected and extractContact returns "" for email
      expectRedirect("https://example.com/thanks")(response);
    });

    test("ticket form with invalid quantity falls back to minimum", async () => {
      const event = await createTestEvent({
        maxAttendees: 50,
        thankYouUrl: "https://example.com/thanks",
        maxQuantity: 5,
      });

      // Submit with non-numeric quantity
      const response = await submitTicketForm(event.slug, {
        name: "John Doe",
        email: "john@example.com",
        quantity: "abc",
      });
      // Should still succeed with quantity falling back to 1
      expectRedirect("https://example.com/thanks")(response);
    });

    test("multi-ticket skips sold-out events in quantity parsing", async () => {
      const event1 = await createTestEvent({
        name: "Multi Soldout Parse 1",
        maxAttendees: 1,
        maxQuantity: 1,
      });
      const event2 = await createTestEvent({
        name: "Multi Soldout Parse 2",
        maxAttendees: 50,
        maxQuantity: 5,
      });

      // Fill up event1 to make it sold out
      await createAttendeeAtomic({ eventId: event1.id, name: "First", email: "first@example.com", quantity: 1 });

      // GET the multi-ticket page (sold-out event will show Sold Out label)
      const path = `/ticket/${event1.slug}+${event2.slug}`;
      const getResponse = await handleRequest(mockRequest(path));
      expect(getResponse.status).toBe(200);
      const html = await getResponse.text();
      expect(html).toContain("Sold Out");

      // POST with quantity for both events - sold out event's quantity is ignored
      const csrfToken = getTicketCsrfToken(html);
      if (!csrfToken) throw new Error("Failed to get CSRF token");

      const response = await handleRequest(
        mockFormRequest(
          path,
          {
            name: "John Doe",
            email: "john@example.com",
            [`quantity_${event1.id}`]: "1",
            [`quantity_${event2.id}`]: "1",
            csrf_token: csrfToken,
          },
          `csrf_token=${csrfToken}`,
        ),
      );
      expectReservedRedirectWithTokens(response);
    });

    test("multi-ticket with invalid quantity form value falls back to 0", async () => {
      const event1 = await createTestEvent({
        name: "Multi Invalid Qty 1",
        maxAttendees: 50,
        maxQuantity: 5,
      });
      const event2 = await createTestEvent({
        name: "Multi Invalid Qty 2",
        maxAttendees: 50,
        maxQuantity: 5,
      });

      const path = `/ticket/${event1.slug}+${event2.slug}`;
      const getResponse = await handleRequest(mockRequest(path));
      const csrfToken = getTicketCsrfToken(await getResponse.text());
      if (!csrfToken) throw new Error("Failed to get CSRF token");

      // Submit with non-numeric quantity for event1 and valid for event2
      const response = await handleRequest(
        mockFormRequest(
          path,
          {
            name: "John Doe",
            email: "john@example.com",
            [`quantity_${event1.id}`]: "abc",
            [`quantity_${event2.id}`]: "1",
            csrf_token: csrfToken,
          },
          `csrf_token=${csrfToken}`,
        ),
      );
      expectReservedRedirectWithTokens(response);

      // Only event2 should have an attendee
      const { getAttendeesRaw } = await import("#lib/db/attendees.ts");
      const attendees1 = await getAttendeesRaw(event1.id);
      const attendees2 = await getAttendeesRaw(event2.id);
      expect(attendees1.length).toBe(0);
      expect(attendees2.length).toBe(1);
    });

    test("multi-ticket paid checks availability and rejects sold out", async () => {
      await setupStripe();

      const event1 = await createTestEvent({
        name: "Multi Avail 1",
        maxAttendees: 1,
        unitPrice: 500,
        maxQuantity: 5,
      });
      const event2 = await createTestEvent({
        name: "Multi Avail 2",
        maxAttendees: 50,
        unitPrice: 1000,
        maxQuantity: 5,
      });

      // Fill event1
      await createAttendeeAtomic({ eventId: event1.id, name: "First", email: "first@example.com", paymentId: "pi_first" });

      const path = `/ticket/${event1.slug}+${event2.slug}`;
      const getResponse = await handleRequest(mockRequest(path));
      const csrfToken = getTicketCsrfToken(await getResponse.text());
      if (!csrfToken) throw new Error("Failed to get CSRF token");

      // Try to purchase - event1 is sold out
      const response = await handleRequest(
        mockFormRequest(
          path,
          {
            name: "John Doe",
            email: "john@example.com",
            [`quantity_${event2.id}`]: "1",
            csrf_token: csrfToken,
          },
          `csrf_token=${csrfToken}`,
        ),
      );

      // Should redirect to checkout since only event2 has quantity (event1 is sold out and skipped)
      expect(response.status).toBe(302);
      resetStripeClient();
    });

    test("returns null for non-ticket paths", async () => {
      const response = await handleRequest(mockRequest("/notticket/test"));
      expect(response.status).toBe(404);
    });

    test("returns null when slug is empty from path extraction", async () => {
      const response = await handleRequest(mockRequest("/ticket/"));
      // Path /ticket/ is normalized to /ticket, which doesn't match slug pattern
      expect(response.status).toBe(404);
    });
  });

  describe("routes/public.ts (multi-ticket CSRF)", () => {
    test("multi-ticket POST rejects invalid CSRF token", async () => {
      const event1 = await createTestEvent({
        name: "Multi Csrf 1",
        maxAttendees: 50,
      });
      const event2 = await createTestEvent({
        name: "Multi Csrf 2",
        maxAttendees: 50,
      });

      // POST without getting CSRF token first
      const response = await handleRequest(
        mockFormRequest(`/ticket/${event1.slug}+${event2.slug}`, {
          name: "John",
          email: "john@example.com",
        }),
      );
      expect(response.status).toBe(403);
      const html = await response.text();
      expect(html).toContain("Invalid or expired form");
    });
  });

  describe("routes/public.ts (withPaymentProvider onMissing path)", () => {
    test("shows payment not configured error for multi-ticket when no provider", async () => {
      await setupStripe();

      const event1 = await createTestEvent({
        name: "Multi Noprov 1",
        maxAttendees: 50,
        unitPrice: 500,
        maxQuantity: 5,
      });
      const event2 = await createTestEvent({
        name: "Multi Noprov 2",
        maxAttendees: 50,
        unitPrice: 1000,
        maxQuantity: 5,
      });

      // Now clear the provider to simulate no provider
      const { clearPaymentProvider } = await import("#lib/db/settings.ts");
      await clearPaymentProvider();

      const path = `/ticket/${event1.slug}+${event2.slug}`;
      const getResponse = await handleRequest(mockRequest(path));
      const csrfToken = getTicketCsrfToken(await getResponse.text());
      if (!csrfToken) throw new Error("Failed to get CSRF token");

      const response = await handleRequest(
        mockFormRequest(
          path,
          {
            name: "John Doe",
            email: "john@example.com",
            [`quantity_${event1.id}`]: "1",
            [`quantity_${event2.id}`]: "1",
            csrf_token: csrfToken,
          },
          `csrf_token=${csrfToken}`,
        ),
      );

      // Free registration path since provider is cleared and isPaymentsEnabled returns false
      expectReservedRedirectWithTokens(response);
      resetStripeClient();
    });
  });

  describe("POST multi-ticket capacity check via atomic create", () => {
    test("shows error for free multi-ticket when atomic create fails", async () => {
      const event1 = await createTestEvent({
        name: "Multi Free Atomic 1",
        maxAttendees: 50,
      });
      const event2 = await createTestEvent({
        name: "Multi Free Atomic 2",
        maxAttendees: 50,
      });

      const path = `/ticket/${event1.slug}+${event2.slug}`;
      const getResponse = await handleRequest(mockRequest(path));
      const csrfToken = getTicketCsrfToken(await getResponse.text());
      if (!csrfToken) throw new Error("Failed to get CSRF token");

      // Mock attendeesApi to fail on second event (capacity exceeded)
      const { attendeesApi } = await import("#lib/db/attendees.ts");
      const originalFn = attendeesApi.createAttendeeAtomic;
      let callCount = 0;
      attendeesApi.createAttendeeAtomic = (input) => {
        callCount++;
        if (callCount === 2) {
          return Promise.resolve({ success: false as const, reason: "capacity_exceeded" as const });
        }
        return originalFn(input);
      };

      try {
        const response = await handleRequest(
          mockFormRequest(path, {
            name: "John Doe",
            email: "john@example.com",
            [`quantity_${event1.id}`]: "1",
            [`quantity_${event2.id}`]: "1",
            csrf_token: csrfToken,
          }, `csrf_token=${csrfToken}`),
        );
        expect(response.status).toBe(400);
        const html = await response.text();
        expect(html).toContain("no longer has enough spots");
      } finally {
        attendeesApi.createAttendeeAtomic = originalFn;
      }
    });
  });

  describe("routes/public.ts (multi-ticket paid flow)", () => {
    afterEach(() => {
      resetStripeClient();
    });

    test("multi-ticket paid flow redirects to Stripe checkout", async () => {
      await setupStripe();

      const event1 = await createTestEvent({
        name: "Multi Paid Flow 1",
        maxAttendees: 50,
        unitPrice: 1000,
      });
      const event2 = await createTestEvent({
        name: "Multi Paid Flow 2",
        maxAttendees: 50,
        unitPrice: 500,
      });

      const path = `/ticket/${event1.slug}+${event2.slug}`;
      const getResponse = await handleRequest(mockRequest(path));
      const csrfToken = getTicketCsrfToken(await getResponse.text());
      if (!csrfToken) throw new Error("Failed to get CSRF token");

      const response = await handleRequest(
        mockFormRequest(path, {
          name: "John Doe",
          email: "john@example.com",
          [`quantity_${event1.id}`]: "1",
          [`quantity_${event2.id}`]: "1",
          csrf_token: csrfToken,
        }, `csrf_token=${csrfToken}`),
      );
      // Should redirect to Stripe checkout
      expect(response.status).toBe(302);
      const location = response.headers.get("location");
      expect(location).toContain("checkout.stripe.com");
    });

    test("multi-ticket paid flow shows error when session creation fails", async () => {
      await setupStripe();

      const event1 = await createTestEvent({
        name: "Multi Nourl 1",
        maxAttendees: 50,
        unitPrice: 1000,
      });
      const event2 = await createTestEvent({
        name: "Multi Nourl 2",
        maxAttendees: 50,
        unitPrice: 500,
      });

      const path = `/ticket/${event1.slug}+${event2.slug}`;
      const getResponse = await handleRequest(mockRequest(path));
      const csrfToken = getTicketCsrfToken(await getResponse.text());
      if (!csrfToken) throw new Error("Failed to get CSRF token");

      // Mock createMultiCheckoutSession to return no URL
      const { stripePaymentProvider } = await import("#lib/stripe-provider.ts");
      const mockCreate = spyOn(stripePaymentProvider, "createMultiCheckoutSession");
      mockCreate.mockResolvedValue(null);

      try {
        const response = await handleRequest(
          mockFormRequest(path, {
            name: "John Doe",
            email: "john@example.com",
            [`quantity_${event1.id}`]: "1",
            [`quantity_${event2.id}`]: "1",
            csrf_token: csrfToken,
          }, `csrf_token=${csrfToken}`),
        );
        expect(response.status).toBe(500);
        const html = await response.text();
        expect(html).toContain("Failed to create payment session");
      } finally {
        mockCreate.mockRestore();
      }
    });

    test("multi-ticket skips sold-out events in quantity parsing", async () => {
      const event1 = await createTestEvent({
        name: "Multi Soldout 1",
        maxAttendees: 1,
      });
      const event2 = await createTestEvent({
        name: "Multi Soldout 2",
        maxAttendees: 50,
      });

      // Fill event1 to capacity
      await createAttendeeAtomic({ eventId: event1.id, name: "First", email: "first@example.com", quantity: 1 });

      const path = `/ticket/${event1.slug}+${event2.slug}`;
      const getResponse = await handleRequest(mockRequest(path));
      const csrfToken = getTicketCsrfToken(await getResponse.text());
      if (!csrfToken) throw new Error("Failed to get CSRF token");

      // Submit with qty for both events, but event1 should be skipped as sold out
      const response = await handleRequest(
        mockFormRequest(path, {
          name: "John Doe",
          email: "john@example.com",
          [`quantity_${event1.id}`]: "1",
          [`quantity_${event2.id}`]: "1",
          csrf_token: csrfToken,
        }, `csrf_token=${csrfToken}`),
      );
      // Should succeed for event2 only
      expectReservedRedirectWithTokens(response);
    });
  });

  describe("routes/public.ts (formatAtomicError encryption_error single-ticket)", () => {
    test("shows encryption error message when atomic create fails with encryption_error", async () => {
      const event = await createTestEvent({
        maxAttendees: 50,
      });

      const { attendeesApi } = await import("#lib/db/attendees.ts");
      const mockAtomic = spyOn(attendeesApi, "createAttendeeAtomic");
      mockAtomic.mockResolvedValue({
        success: false,
        reason: "encryption_error",
      });

      try {
        const response = await submitTicketForm(event.slug, {
          name: "John Doe",
          email: "john@example.com",
        });
        expect(response.status).toBe(400);
        const html = await response.text();
        expect(html).toContain("Registration failed");
        expect(html).toContain("Please try again");
      } finally {
        mockAtomic.mockRestore();
      }
    });
  });

  describe("routes/public.ts (multi-ticket quantity field missing from form)", () => {
    test("defaults to 0 when quantity field is absent from multi-ticket form", async () => {
      const event1 = await createTestEvent({
        name: "Multi Nofield 1",
        maxAttendees: 50,
        maxQuantity: 5,
      });
      const event2 = await createTestEvent({
        name: "Multi Nofield 2",
        maxAttendees: 50,
        maxQuantity: 5,
      });

      const path = `/ticket/${event1.slug}+${event2.slug}`;
      const getResponse = await handleRequest(mockRequest(path));
      const csrfToken = getTicketCsrfToken(await getResponse.text());
      if (!csrfToken) throw new Error("Failed to get CSRF token");

      // Submit form with quantity for event2 only; event1 has no quantity field at all
      const response = await handleRequest(
        mockFormRequest(
          path,
          {
            name: "John Doe",
            email: "john@example.com",
            [`quantity_${event2.id}`]: "1",
            csrf_token: csrfToken,
          },
          `csrf_token=${csrfToken}`,
        ),
      );
      expectReservedRedirectWithTokens(response);

      // Verify only event2 got an attendee
      const { getAttendeesRaw } = await import("#lib/db/attendees.ts");
      const attendees1 = await getAttendeesRaw(event1.id);
      const attendees2 = await getAttendeesRaw(event2.id);
      expect(attendees1.length).toBe(0);
      expect(attendees2.length).toBe(1);
    });
  });

  describe("routes/public.ts (multi-ticket paid availability check fails)", () => {
    afterEach(() => {
      resetStripeClient();
    });

    test("returns error when paid multi-ticket availability check fails", async () => {
      await setupStripe();

      const event1 = await createTestEvent({
        name: "Multi Avail Race 1",
        maxAttendees: 50,
        unitPrice: 500,
        maxQuantity: 5,
      });
      const event2 = await createTestEvent({
        name: "Multi Avail Race 2",
        maxAttendees: 50,
        unitPrice: 1000,
        maxQuantity: 5,
      });

      const path = `/ticket/${event1.slug}+${event2.slug}`;
      const getResponse = await handleRequest(mockRequest(path));
      const csrfToken = getTicketCsrfToken(await getResponse.text());
      if (!csrfToken) throw new Error("Failed to get CSRF token");

      // Mock checkBatchAvailability via attendeesApi to return false,
      // simulating a race condition where event sells out between page load and check
      const { attendeesApi } = await import("#lib/db/attendees.ts");
      const mockBatch = spyOn(attendeesApi, "checkBatchAvailability");
      mockBatch.mockImplementation(() => Promise.resolve(false));

      try {
        const response = await handleRequest(
          mockFormRequest(
            path,
            {
              name: "John Doe",
              email: "john@example.com",
              [`quantity_${event1.id}`]: "1",
              [`quantity_${event2.id}`]: "1",
              csrf_token: csrfToken,
            },
            `csrf_token=${csrfToken}`,
          ),
        );

        expect(response.status).toBe(400);
        const html = await response.text();
        expect(html).toContain("some tickets are no longer available");
      } finally {
        mockBatch.mockRestore();
      }
    });
  });

  describe("iframe checkout popup (Stripe cannot run in iframes)", () => {
    afterEach(() => {
      resetStripeClient();
    });

    test("returns popup page instead of redirect for single-ticket paid event in iframe", async () => {
      await setupStripe();
      const event = await createTestEvent({
        name: "Iframe Paid Single",
        maxAttendees: 50,
        unitPrice: 1000,
      });

      const path = `/ticket/${event.slug}?iframe=true`;
      const getResponse = await handleRequest(mockRequest(path));
      const csrfToken = getTicketCsrfToken(await getResponse.text());
      if (!csrfToken) throw new Error("Failed to get CSRF token");

      const response = await handleRequest(
        mockFormRequest(
          path,
          { name: "John Doe", email: "john@example.com", csrf_token: csrfToken },
          `csrf_token=${csrfToken}`,
        ),
      );

      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("data-checkout-popup");
      expect(html).toContain("Pay Now");
      expect(html).toContain('target="_blank"');
    });

    test("returns 302 redirect for single-ticket paid event without iframe", async () => {
      await setupStripe();
      const event = await createTestEvent({
        name: "Non-iframe Paid Single",
        maxAttendees: 50,
        unitPrice: 1000,
      });

      const response = await submitTicketForm(event.slug, {
        name: "John Doe",
        email: "john@example.com",
      });

      expect(response.status).toBe(302);
      const location = response.headers.get("location");
      expect(location).not.toBeNull();
      expect(location?.startsWith("https://")).toBe(true);
    });

    test("returns popup page for multi-ticket paid event in iframe", async () => {
      await setupStripe();
      const event1 = await createTestEvent({
        name: "Iframe Multi 1",
        maxAttendees: 50,
        unitPrice: 500,
        maxQuantity: 5,
      });
      const event2 = await createTestEvent({
        name: "Iframe Multi 2",
        maxAttendees: 50,
        unitPrice: 1000,
        maxQuantity: 5,
      });

      const path = `/ticket/${event1.slug}+${event2.slug}?iframe=true`;
      const getResponse = await handleRequest(mockRequest(path));
      const csrfToken = getTicketCsrfToken(await getResponse.text());
      if (!csrfToken) throw new Error("Failed to get CSRF token");

      const response = await handleRequest(
        mockFormRequest(
          path,
          {
            name: "John Doe",
            email: "john@example.com",
            [`quantity_${event1.id}`]: "1",
            [`quantity_${event2.id}`]: "1",
            csrf_token: csrfToken,
          },
          `csrf_token=${csrfToken}`,
        ),
      );

      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("data-checkout-popup");
      expect(html).toContain("Pay Now");
      expect(html).toContain('target="_blank"');
    });
  });

  describe("routes/public.ts (withPaymentProvider onMissing single-ticket)", () => {
    afterEach(() => {
      resetStripeClient();
    });

    test("shows payment not configured error when provider returns null for single-ticket", async () => {
      await setupStripe();

      const event = await createTestEvent({
        maxAttendees: 50,
        unitPrice: 1000,
      });

      // Mock paymentsApi.getConfiguredProvider to return null so getActivePaymentProvider
      // returns null, while isPaymentsEnabled still returns true from the DB
      const { paymentsApi } = await import("#lib/payments.ts");
      const mockConfigured = spyOn(paymentsApi, "getConfiguredProvider");
      mockConfigured.mockResolvedValue(null);

      try {
        const response = await submitTicketForm(event.slug, {
          name: "John Doe",
          email: "john@example.com",
        });

        expect(response.status).toBe(500);
        const html = await response.text();
        expect(html).toContain("Payments are not configured");
      } finally {
        mockConfigured.mockRestore();
      }
    });
  });

  describe("routes/public.ts (withPaymentProvider onMissing multi-ticket)", () => {
    afterEach(() => {
      resetStripeClient();
    });

    test("shows payment not configured error when provider returns null for multi-ticket", async () => {
      await setupStripe();

      const event1 = await createTestEvent({
        name: "Multi Noprov Miss 1",
        maxAttendees: 50,
        unitPrice: 500,
        maxQuantity: 5,
      });
      const event2 = await createTestEvent({
        name: "Multi Noprov Miss 2",
        maxAttendees: 50,
        unitPrice: 1000,
        maxQuantity: 5,
      });

      const path = `/ticket/${event1.slug}+${event2.slug}`;
      const getResponse = await handleRequest(mockRequest(path));
      const csrfToken = getTicketCsrfToken(await getResponse.text());
      if (!csrfToken) throw new Error("Failed to get CSRF token");

      // Mock paymentsApi.getConfiguredProvider to return null so getActivePaymentProvider
      // returns null, while isPaymentsEnabled still returns true from the DB
      const { paymentsApi } = await import("#lib/payments.ts");
      const mockConfigured = spyOn(paymentsApi, "getConfiguredProvider");
      mockConfigured.mockResolvedValue(null);

      try {
        const response = await handleRequest(
          mockFormRequest(
            path,
            {
              name: "John Doe",
              email: "john@example.com",
              [`quantity_${event1.id}`]: "1",
              [`quantity_${event2.id}`]: "1",
              csrf_token: csrfToken,
            },
            `csrf_token=${csrfToken}`,
          ),
        );

        expect(response.status).toBe(500);
        const html = await response.text();
        expect(html).toContain("Payments are not configured");
      } finally {
        mockConfigured.mockRestore();
      }
    });
  });

  describe("closes_at (single ticket)", () => {
    test("shows 'Registration closed.' when closes_at is in the past", async () => {
      const pastDate = new Date(Date.now() - 60000).toISOString().slice(0, 16);
      const event = await createTestEvent({ closesAt: pastDate });

      const response = await handleRequest(
        mockRequest(`/ticket/${event.slug}`),
      );
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Registration closed.");
      expect(html).not.toContain("Reserve Ticket");
    });

    test("shows form when closes_at is in the future", async () => {
      const futureDate = new Date(Date.now() + 3600000).toISOString().slice(0, 16);
      const event = await createTestEvent({ closesAt: futureDate });

      const response = await handleRequest(
        mockRequest(`/ticket/${event.slug}`),
      );
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).not.toContain("Registration closed.");
      expect(html).toContain("Reserve Ticket");
    });

    test("shows form when closes_at is null", async () => {
      const event = await createTestEvent();

      const response = await handleRequest(
        mockRequest(`/ticket/${event.slug}`),
      );
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).not.toContain("Registration closed.");
      expect(html).toContain("Reserve Ticket");
    });

    test("shows 'registration closed while you were submitting' on POST when closes_at is past", async () => {
      // Create event with future closes_at so we can get CSRF token
      const futureDate = new Date(Date.now() + 3600000).toISOString().slice(0, 16);
      const event = await createTestEvent({ closesAt: futureDate });

      // Get CSRF token from the ticket page
      const getResponse = await handleRequest(
        mockRequest(`/ticket/${event.slug}`),
      );
      const csrfToken = getTicketCsrfToken(await getResponse.text());
      if (!csrfToken) throw new Error("No CSRF token");

      // Now set closes_at to past
      const pastDate = new Date(Date.now() - 60000).toISOString().slice(0, 16);
      await updateTestEvent(event.id, { closesAt: pastDate });

      const response = await handleRequest(
        mockFormRequest(
          `/ticket/${event.slug}`,
          {
            name: "Test User",
            email: "test@example.com",
            quantity: "1",
            csrf_token: csrfToken,
          },
          `csrf_token=${csrfToken}`,
        ),
      );
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("Sorry, registration closed while you were submitting.");
    });
  });

  describe("closes_at (multi-ticket)", () => {
    test("shows 'Registration closed.' when all events are closed", async () => {
      const pastDate = new Date(Date.now() - 60000).toISOString().slice(0, 16);
      const event1 = await createTestEvent({ closesAt: pastDate });
      const event2 = await createTestEvent({ closesAt: pastDate });

      const response = await handleRequest(
        mockRequest(`/ticket/${event1.slug}+${event2.slug}`),
      );
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Registration closed.");
    });

    test("shows 'Registration Closed' label for individual closed event in multi-ticket", async () => {
      const pastDate = new Date(Date.now() - 60000).toISOString().slice(0, 16);
      const event1 = await createTestEvent({ closesAt: pastDate });
      const event2 = await createTestEvent();

      const response = await handleRequest(
        mockRequest(`/ticket/${event1.slug}+${event2.slug}`),
      );
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Registration Closed");
      expect(html).toContain(event2.name); // open event shows form
    });

    test("shows error on POST when event closes during submission", async () => {
      // Create two events, one will close during submission
      const futureDate = new Date(Date.now() + 3600000).toISOString().slice(0, 16);
      const event1 = await createTestEvent({ closesAt: futureDate });
      const event2 = await createTestEvent();

      // Get CSRF token
      const getResponse = await handleRequest(
        mockRequest(`/ticket/${event1.slug}+${event2.slug}`),
      );
      const csrfToken = getTicketCsrfToken(await getResponse.text());
      if (!csrfToken) throw new Error("No CSRF token");

      // Close event1
      const pastDate = new Date(Date.now() - 60000).toISOString().slice(0, 16);
      await updateTestEvent(event1.id, { closesAt: pastDate });

      const response = await handleRequest(
        mockFormRequest(
          `/ticket/${event1.slug}+${event2.slug}`,
          {
            name: "Test User",
            email: "test@example.com",
            [`quantity_${event1.id}`]: "1",
            [`quantity_${event2.id}`]: "1",
            csrf_token: csrfToken,
          },
          `csrf_token=${csrfToken}`,
        ),
      );
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("Sorry, registration closed while you were submitting.");
    });
  });

  describe("daily events (single ticket)", () => {
    // A valid bookable date: tomorrow (today + 1 day)
    const validDate = addDays(todayInTz("UTC"), 1);

    test("GET shows date selector for daily event", async () => {
      const event = await createTestEvent({
        eventType: "daily",
        bookableDays: JSON.stringify(["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]),
        minimumDaysBefore: 0,
        maximumDaysAfter: 14,
      });
      const response = await handleRequest(mockRequest(`/ticket/${event.slug}`));
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Select Date");
      expect(html).toContain('<select name="date"');
    });

    test("GET shows no-dates message when no dates available", async () => {
      // Create a daily event where minimum_days_before > maximum_days_after
      // so the date range is empty (start > end)
      const event = await createTestEvent({
        eventType: "daily",
        bookableDays: JSON.stringify(["Monday"]),
        minimumDaysBefore: 30,
        maximumDaysAfter: 7,
      });
      const response = await handleRequest(mockRequest(`/ticket/${event.slug}`));
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("No dates are currently available for booking");
    });

    test("POST succeeds for free daily event with valid date", async () => {
      const event = await createTestEvent({
        eventType: "daily",
        bookableDays: JSON.stringify(["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]),
        minimumDaysBefore: 0,
        maximumDaysAfter: 14,
      });
      const response = await submitTicketForm(event.slug, {
        name: "Daily User",
        email: "daily@example.com",
        date: validDate,
      });
      expectRedirect("https://example.com/thanks")(response);
    });

    test("POST rejects daily event with missing date", async () => {
      const event = await createTestEvent({
        eventType: "daily",
        bookableDays: JSON.stringify(["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]),
        minimumDaysBefore: 0,
        maximumDaysAfter: 14,
      });
      const response = await submitTicketForm(event.slug, {
        name: "Daily User",
        email: "daily@example.com",
      });
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("Please select a valid date");
    });

    test("POST rejects daily event with invalid date", async () => {
      const event = await createTestEvent({
        eventType: "daily",
        bookableDays: JSON.stringify(["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]),
        minimumDaysBefore: 0,
        maximumDaysAfter: 14,
      });
      const response = await submitTicketForm(event.slug, {
        name: "Daily User",
        email: "daily@example.com",
        date: "2099-01-01",
      });
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("Please select a valid date");
    });

    test("POST checks per-date capacity for daily events", async () => {
      const event = await createTestEvent({
        eventType: "daily",
        bookableDays: JSON.stringify(["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]),
        minimumDaysBefore: 0,
        maximumDaysAfter: 14,
        maxAttendees: 1,
      });

      // Fill up the date
      await submitTicketForm(event.slug, {
        name: "First User",
        email: "first@example.com",
        date: validDate,
      });

      // Second booking for same date should fail
      const response = await submitTicketForm(event.slug, {
        name: "Second User",
        email: "second@example.com",
        date: validDate,
      });
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("not enough spots available");
    });

    test("POST allows booking different dates at capacity", async () => {
      const event = await createTestEvent({
        eventType: "daily",
        bookableDays: JSON.stringify(["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]),
        minimumDaysBefore: 0,
        maximumDaysAfter: 14,
        maxAttendees: 1,
      });

      // Book first date
      const response1 = await submitTicketForm(event.slug, {
        name: "First User",
        email: "first@example.com",
        date: validDate,
      });
      expect(response1.status).toBe(302);

      // Book different date should succeed
      const otherDate = addDays(todayInTz("UTC"), 2);
      const response2 = await submitTicketForm(event.slug, {
        name: "Second User",
        email: "second@example.com",
        date: otherDate,
      });
      expect(response2.status).toBe(302);
    });

    test("POST redirects to checkout for paid daily event", async () => {
      await setupStripe();

      const event = await createTestEvent({
        eventType: "daily",
        bookableDays: JSON.stringify(["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]),
        minimumDaysBefore: 0,
        maximumDaysAfter: 14,
        unitPrice: 500,
      });

      const getResponse = await handleRequest(mockRequest(`/ticket/${event.slug}`));
      const csrfToken = getTicketCsrfToken(await getResponse.text());
      if (!csrfToken) throw new Error("Failed to get CSRF token");

      const response = await handleRequest(
        mockFormRequest(
          `/ticket/${event.slug}`,
          {
            name: "Paid Daily User",
            email: "paid@example.com",
            date: validDate,
            csrf_token: csrfToken,
          },
          `csrf_token=${csrfToken}`,
        ),
      );
      expect(response.status).toBe(302);
      const location = response.headers.get("location");
      expect(location).not.toBeNull();

      resetStripeClient();
    });

    test("daily event excludes holiday dates", async () => {
      // Create a holiday covering tomorrow
      await createTestHoliday({
        name: "Test Holiday",
        startDate: validDate,
        endDate: validDate,
      });

      const event = await createTestEvent({
        eventType: "daily",
        bookableDays: JSON.stringify(["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]),
        minimumDaysBefore: 0,
        maximumDaysAfter: 14,
      });
      const response = await handleRequest(mockRequest(`/ticket/${event.slug}`));
      expect(response.status).toBe(200);
      const html = await response.text();
      // The holiday date should not appear as an option
      expect(html).not.toContain(`value="${validDate}"`);
    });
  });

  describe("daily events (multi-ticket)", () => {
    const validDate = addDays(todayInTz("UTC"), 1);

    test("GET shows date selector for multi-ticket with daily events", async () => {
      const event1 = await createTestEvent({
        eventType: "daily",
        bookableDays: JSON.stringify(["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]),
        minimumDaysBefore: 0,
        maximumDaysAfter: 14,
      });
      const event2 = await createTestEvent({
        eventType: "daily",
        bookableDays: JSON.stringify(["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]),
        minimumDaysBefore: 0,
        maximumDaysAfter: 14,
      });
      const response = await handleRequest(
        mockRequest(`/ticket/${event1.slug}+${event2.slug}`),
      );
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Select Date");
      expect(html).toContain('<select name="date"');
    });

    test("POST rejects multi-ticket daily event without date", async () => {
      const event1 = await createTestEvent({
        eventType: "daily",
        bookableDays: JSON.stringify(["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]),
        minimumDaysBefore: 0,
        maximumDaysAfter: 14,
      });
      const event2 = await createTestEvent({
        eventType: "daily",
        bookableDays: JSON.stringify(["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]),
        minimumDaysBefore: 0,
        maximumDaysAfter: 14,
      });

      const path = `/ticket/${event1.slug}+${event2.slug}`;
      const getResponse = await handleRequest(mockRequest(path));
      const csrfToken = getTicketCsrfToken(await getResponse.text());
      if (!csrfToken) throw new Error("No CSRF token");

      const response = await handleRequest(
        mockFormRequest(
          path,
          {
            name: "Test User",
            email: "test@example.com",
            [`quantity_${event1.id}`]: "1",
            [`quantity_${event2.id}`]: "1",
            csrf_token: csrfToken,
          },
          `csrf_token=${csrfToken}`,
        ),
      );
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("Please select a valid date");
    });

    test("POST succeeds for free multi-ticket daily events with valid date", async () => {
      const event1 = await createTestEvent({
        eventType: "daily",
        bookableDays: JSON.stringify(["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]),
        minimumDaysBefore: 0,
        maximumDaysAfter: 14,
      });
      const event2 = await createTestEvent({
        eventType: "daily",
        bookableDays: JSON.stringify(["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]),
        minimumDaysBefore: 0,
        maximumDaysAfter: 14,
      });

      const path = `/ticket/${event1.slug}+${event2.slug}`;
      const getResponse = await handleRequest(mockRequest(path));
      const csrfToken = getTicketCsrfToken(await getResponse.text());
      if (!csrfToken) throw new Error("No CSRF token");

      const response = await handleRequest(
        mockFormRequest(
          path,
          {
            name: "Multi Daily User",
            email: "multidaily@example.com",
            date: validDate,
            [`quantity_${event1.id}`]: "1",
            [`quantity_${event2.id}`]: "1",
            csrf_token: csrfToken,
          },
          `csrf_token=${csrfToken}`,
        ),
      );
      expectReservedRedirectWithTokens(response);
    });

    test("POST redirects to checkout for paid multi-ticket daily events", async () => {
      await setupStripe();

      const event1 = await createTestEvent({
        eventType: "daily",
        bookableDays: JSON.stringify(["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]),
        minimumDaysBefore: 0,
        maximumDaysAfter: 14,
        unitPrice: 500,
      });
      const event2 = await createTestEvent({
        eventType: "daily",
        bookableDays: JSON.stringify(["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]),
        minimumDaysBefore: 0,
        maximumDaysAfter: 14,
        unitPrice: 300,
      });

      const path = `/ticket/${event1.slug}+${event2.slug}`;
      const getResponse = await handleRequest(mockRequest(path));
      const csrfToken = getTicketCsrfToken(await getResponse.text());
      if (!csrfToken) throw new Error("No CSRF token");

      const response = await handleRequest(
        mockFormRequest(
          path,
          {
            name: "Multi Daily Paid",
            email: "multipaid@example.com",
            date: validDate,
            [`quantity_${event1.id}`]: "1",
            [`quantity_${event2.id}`]: "1",
            csrf_token: csrfToken,
          },
          `csrf_token=${csrfToken}`,
        ),
      );
      expect(response.status).toBe(302);
      const location = response.headers.get("location");
      expect(location).not.toBeNull();

      resetStripeClient();
    });

    test("shows date and location on multi-ticket page when events have them", async () => {
      const event1 = await createTestEvent({
        name: "Multi Date 1",
        maxAttendees: 50,
        date: "2026-06-15T14:00",
        location: "Village Hall",
      });
      const event2 = await createTestEvent({
        name: "Multi Date 2",
        maxAttendees: 50,
      });
      const response = await handleRequest(
        mockRequest(`/ticket/${event1.slug}+${event2.slug}`),
      );
      expect(response.status).toBe(200);
      const html = await response.text();
      // Event 1 has date and location, event 2 does not
      expect(html).toContain("Multi Date 1");
      expect(html).toContain("Multi Date 2");
    });

    test("computes shared dates across daily events", async () => {
      // event1: only bookable on Monday, event2: bookable all days
      // Shared dates should only be Mondays
      const event1 = await createTestEvent({
        eventType: "daily",
        bookableDays: JSON.stringify(["Monday"]),
        minimumDaysBefore: 0,
        maximumDaysAfter: 14,
      });
      const event2 = await createTestEvent({
        eventType: "daily",
        bookableDays: JSON.stringify(["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]),
        minimumDaysBefore: 0,
        maximumDaysAfter: 14,
      });
      const response = await handleRequest(
        mockRequest(`/ticket/${event1.slug}+${event2.slug}`),
      );
      expect(response.status).toBe(200);
      const html = await response.text();
      // Should contain Monday dates but not Tuesday dates
      expect(html).toContain("Monday");
      expect(html).not.toContain("Tuesday");
    });
  });

  describe("terms and conditions (single ticket)", () => {
    test("shows terms checkbox when terms are configured", async () => {
      await updateTermsAndConditions("I agree to the event rules.");

      const event = await createTestEvent({ maxAttendees: 50 });
      const response = await handleRequest(mockRequest(`/ticket/${event.slug}`));
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("agree_terms");
      expect(html).toContain("I agree to the event rules.");
      expect(html).toContain("I agree to the terms and conditions above");
    });

    test("does not show terms checkbox when no terms configured", async () => {
      const event = await createTestEvent({ maxAttendees: 50 });
      const response = await handleRequest(mockRequest(`/ticket/${event.slug}`));
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).not.toContain("agree_terms");
    });

    test("rejects submission without agreeing to terms", async () => {
      await updateTermsAndConditions("You must accept the rules.");

      const event = await createTestEvent({ maxAttendees: 50 });
      const response = await submitTicketForm(event.slug, {
        name: "John Doe",
        email: "john@example.com",
      });
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("You must agree to the terms and conditions");
    });

    test("accepts submission when terms are agreed to", async () => {
      await updateTermsAndConditions("You must accept the rules.");

      const event = await createTestEvent({
        maxAttendees: 50,
        thankYouUrl: "https://example.com/thanks",
      });
      const response = await submitTicketForm(event.slug, {
        name: "John Doe",
        email: "john@example.com",
        agree_terms: "1",
      });
      expectRedirect("https://example.com/thanks")(response);
    });

    test("succeeds without checkbox when no terms configured", async () => {
      const event = await createTestEvent({
        maxAttendees: 50,
        thankYouUrl: "https://example.com/thanks",
      });
      const response = await submitTicketForm(event.slug, {
        name: "John Doe",
        email: "john@example.com",
      });
      expectRedirect("https://example.com/thanks")(response);
    });
  });

  describe("terms and conditions (multi-ticket)", () => {
    test("shows terms checkbox on multi-ticket page when configured", async () => {
      await updateTermsAndConditions("Multi-event terms apply.");

      const event1 = await createTestEvent({ name: "TC Multi 1", maxAttendees: 50 });
      const event2 = await createTestEvent({ name: "TC Multi 2", maxAttendees: 50 });
      const response = await handleRequest(
        mockRequest(`/ticket/${event1.slug}+${event2.slug}`),
      );
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("agree_terms");
      expect(html).toContain("Multi-event terms apply.");
    });

    test("rejects multi-ticket submission without agreeing to terms", async () => {
      await updateTermsAndConditions("Must agree to policy.");

      const event1 = await createTestEvent({ name: "TC Multi Rej 1", maxAttendees: 50 });
      const event2 = await createTestEvent({ name: "TC Multi Rej 2", maxAttendees: 50 });

      const path = `/ticket/${event1.slug}+${event2.slug}`;
      const getResponse = await handleRequest(mockRequest(path));
      const csrfToken = getTicketCsrfToken(await getResponse.text());
      if (!csrfToken) throw new Error("Failed to get CSRF token");

      const response = await handleRequest(
        mockFormRequest(
          path,
          {
            name: "John Doe",
            email: "john@example.com",
            [`quantity_${event1.id}`]: "1",
            [`quantity_${event2.id}`]: "1",
            csrf_token: csrfToken,
          },
          `csrf_token=${csrfToken}`,
        ),
      );
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("You must agree to the terms and conditions");
    });

    test("accepts multi-ticket submission when terms are agreed to", async () => {
      await updateTermsAndConditions("Must agree to policy.");

      const event1 = await createTestEvent({ name: "TC Multi Ok 1", maxAttendees: 50 });
      const event2 = await createTestEvent({ name: "TC Multi Ok 2", maxAttendees: 50 });

      const path = `/ticket/${event1.slug}+${event2.slug}`;
      const getResponse = await handleRequest(mockRequest(path));
      const csrfToken = getTicketCsrfToken(await getResponse.text());
      if (!csrfToken) throw new Error("Failed to get CSRF token");

      const response = await handleRequest(
        mockFormRequest(
          path,
          {
            name: "John Doe",
            email: "john@example.com",
            [`quantity_${event1.id}`]: "1",
            [`quantity_${event2.id}`]: "1",
            agree_terms: "1",
            csrf_token: csrfToken,
          },
          `csrf_token=${csrfToken}`,
        ),
      );
      expectReservedRedirectWithTokens(response);
    });
  });

});
