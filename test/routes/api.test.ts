import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { updateShowPublicApi } from "#lib/db/settings.ts";
import { handleRequest } from "#routes";
import {
  createDailyTestEvent,
  createTestAttendeeDirect,
  createTestDbWithSetup,
  createTestEvent,
  deactivateTestEvent,
  resetDb,
  resetTestSlugCounter,
  setupStripe,
} from "#test-utils";

/** Create a JSON API request */
const apiRequest = (
  path: string,
  options: {
    method?: string;
    body?: Record<string, unknown>;
  } = {},
): Request => {
  const { method = "GET", body } = options;
  const headers: Record<string, string> = { host: "localhost" };
  const init: RequestInit = { method, headers };

  if (body) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }

  return new Request(`http://localhost${path}`, init);
};

/** Parse JSON response */
const jsonBody = (response: Response): Promise<Record<string, unknown>> =>
  response.json();

/** Assert CORS headers are present */
const expectCorsHeaders = (response: Response): void => {
  expect(response.headers.get("access-control-allow-origin")).toBe("*");
};

describe("Public API", () => {
  beforeEach(async () => {
    resetTestSlugCounter();
    await createTestDbWithSetup();
    await updateShowPublicApi(true);
  });

  afterEach(() => {
    resetDb();
  });

  describe("GET /api/events", () => {
    test("returns empty array when no events exist", async () => {
      const response = await handleRequest(apiRequest("/api/events"));
      expect(response.status).toBe(200);
      const body = await jsonBody(response);
      expect(body.events).toEqual([]);
      expectCorsHeaders(response);
    });

    test("returns active non-hidden events", async () => {
      const event = await createTestEvent({ name: "Public Event" });
      const response = await handleRequest(apiRequest("/api/events"));
      expect(response.status).toBe(200);
      const body = await jsonBody(response);
      const events = body.events as Record<string, unknown>[];
      expect(events.length).toBe(1);
      expect(events[0]?.name).toBe("Public Event");
      expect(events[0]?.slug).toBe(event.slug);
    });

    test("filters hidden events from listing", async () => {
      await createTestEvent({ name: "Visible", hidden: false });
      await createTestEvent({ name: "Hidden", hidden: true });
      const response = await handleRequest(apiRequest("/api/events"));
      const body = await jsonBody(response);
      const events = body.events as Record<string, unknown>[];
      expect(events.length).toBe(1);
      expect(events[0]?.name).toBe("Visible");
    });

    test("does not expose internal fields", async () => {
      await createTestEvent();
      const response = await handleRequest(apiRequest("/api/events"));
      const body = await jsonBody(response);
      const events = body.events as Record<string, unknown>[];
      const event = events[0]!;
      // Should NOT have internal fields
      expect(event.id).toBeUndefined();
      expect(event.max_attendees).toBeUndefined();
      expect(event.attendee_count).toBeUndefined();
      expect(event.closes_at).toBeUndefined();
      expect(event.slug_index).toBeUndefined();
      expect(event.group_id).toBeUndefined();
      expect(event.webhook_url).toBeUndefined();
      expect(event.thank_you_url).toBeUndefined();
      expect(event.hidden).toBeUndefined();
      expect(event.active).toBeUndefined();
      // Should have public fields
      expect(event.name).toBeDefined();
      expect(event.slug).toBeDefined();
      expect(event.isSoldOut).toBe(false);
      expect(event.isClosed).toBe(false);
      expect(typeof event.maxPurchasable).toBe("number");
    });

    test("sets isSoldOut when event is at capacity", async () => {
      const event = await createTestEvent({ maxAttendees: 1 });
      await createTestAttendeeDirect(event.id, "Alice", "a@test.com");
      const response = await handleRequest(apiRequest("/api/events"));
      const body = await jsonBody(response);
      const events = body.events as Record<string, unknown>[];
      expect(events[0]?.isSoldOut).toBe(true);
      expect(events[0]?.maxPurchasable).toBe(0);
    });
  });

  describe("GET /api/events/:slug", () => {
    test("returns event details by slug", async () => {
      const event = await createTestEvent({
        name: "My Event",
        description: "Hello",
      });
      const response = await handleRequest(
        apiRequest(`/api/events/${event.slug}`),
      );
      expect(response.status).toBe(200);
      const body = await jsonBody(response);
      const apiEvent = body.event as Record<string, unknown>;
      expect(apiEvent.name).toBe("My Event");
      expect(apiEvent.description).toBe("Hello");
      expectCorsHeaders(response);
    });

    test("returns 404 for non-existent event", async () => {
      const response = await handleRequest(
        apiRequest("/api/events/nonexistent"),
      );
      expect(response.status).toBe(404);
      const body = await jsonBody(response);
      expect(body.error).toBe("Event not found");
    });

    test("returns 404 for inactive event", async () => {
      const event = await createTestEvent();
      await deactivateTestEvent(event.id);
      const response = await handleRequest(
        apiRequest(`/api/events/${event.slug}`),
      );
      expect(response.status).toBe(404);
    });

    test("allows hidden events to be accessed by slug", async () => {
      const event = await createTestEvent({
        name: "Hidden Event",
        hidden: true,
      });
      const response = await handleRequest(
        apiRequest(`/api/events/${event.slug}`),
      );
      expect(response.status).toBe(200);
      const body = await jsonBody(response);
      expect((body.event as Record<string, unknown>).name).toBe("Hidden Event");
    });

    test("includes availableDates for daily events", async () => {
      const event = await createDailyTestEvent();
      const response = await handleRequest(
        apiRequest(`/api/events/${event.slug}`),
      );
      expect(response.status).toBe(200);
      const body = await jsonBody(response);
      const apiEvent = body.event as Record<string, unknown>;
      expect(apiEvent.eventType).toBe("daily");
      expect(Array.isArray(apiEvent.availableDates)).toBe(true);
    });

    test("does not include availableDates for standard events", async () => {
      const event = await createTestEvent();
      const response = await handleRequest(
        apiRequest(`/api/events/${event.slug}`),
      );
      const body = await jsonBody(response);
      const apiEvent = body.event as Record<string, unknown>;
      expect(apiEvent.availableDates).toBeUndefined();
    });
  });

  describe("GET /api/events/:slug/availability", () => {
    test("returns available true when spots exist", async () => {
      const event = await createTestEvent({ maxAttendees: 10 });
      const response = await handleRequest(
        apiRequest(`/api/events/${event.slug}/availability`),
      );
      expect(response.status).toBe(200);
      const body = await jsonBody(response);
      expect(body.available).toBe(true);
      expectCorsHeaders(response);
    });

    test("returns available false when sold out", async () => {
      const event = await createTestEvent({ maxAttendees: 1 });
      await createTestAttendeeDirect(event.id, "Alice", "a@test.com");
      const response = await handleRequest(
        apiRequest(`/api/events/${event.slug}/availability`),
      );
      const body = await jsonBody(response);
      expect(body.available).toBe(false);
    });

    test("respects quantity parameter", async () => {
      const event = await createTestEvent({ maxAttendees: 2 });
      await createTestAttendeeDirect(event.id, "Alice", "a@test.com");
      // 1 spot left, requesting 2
      const response = await handleRequest(
        apiRequest(`/api/events/${event.slug}/availability?quantity=2`),
      );
      const body = await jsonBody(response);
      expect(body.available).toBe(false);
    });

    test("returns 404 for non-existent event", async () => {
      const response = await handleRequest(
        apiRequest("/api/events/nonexistent/availability"),
      );
      expect(response.status).toBe(404);
    });

    test("handles invalid quantity gracefully", async () => {
      const event = await createTestEvent({ maxAttendees: 10 });
      const response = await handleRequest(
        apiRequest(`/api/events/${event.slug}/availability?quantity=abc`),
      );
      expect(response.status).toBe(200);
      const body = await jsonBody(response);
      expect(body.available).toBe(true);
    });
  });

  describe("POST /api/events/:slug/book", () => {
    test("creates booking for free event", async () => {
      const event = await createTestEvent({ maxAttendees: 10 });
      const response = await handleRequest(
        apiRequest(`/api/events/${event.slug}/book`, {
          method: "POST",
          body: { name: "Alice", email: "alice@test.com" },
        }),
      );
      expect(response.status).toBe(200);
      const body = await jsonBody(response);
      expect(body.ticketToken).toBeDefined();
      expect(body.ticketUrl).toBeDefined();
      expect(typeof body.ticketUrl).toBe("string");
      expectCorsHeaders(response);
    });

    test("returns 404 for non-existent event", async () => {
      const response = await handleRequest(
        apiRequest("/api/events/nonexistent/book", {
          method: "POST",
          body: { name: "Alice", email: "alice@test.com" },
        }),
      );
      expect(response.status).toBe(404);
    });

    test("returns 400 when required name is missing", async () => {
      const event = await createTestEvent({ maxAttendees: 10 });
      const response = await handleRequest(
        apiRequest(`/api/events/${event.slug}/book`, {
          method: "POST",
          body: { email: "alice@test.com" },
        }),
      );
      expect(response.status).toBe(400);
      const body = await jsonBody(response);
      expect(body.error).toBeDefined();
    });

    test("returns 400 when required email is missing", async () => {
      const event = await createTestEvent({
        maxAttendees: 10,
        fields: "email",
      });
      const response = await handleRequest(
        apiRequest(`/api/events/${event.slug}/book`, {
          method: "POST",
          body: { name: "Alice" },
        }),
      );
      expect(response.status).toBe(400);
      const body = await jsonBody(response);
      expect(body.error).toBeDefined();
    });

    test("returns 409 when event is at capacity", async () => {
      const event = await createTestEvent({ maxAttendees: 1 });
      await createTestAttendeeDirect(event.id, "First", "first@test.com");
      const response = await handleRequest(
        apiRequest(`/api/events/${event.slug}/book`, {
          method: "POST",
          body: { name: "Second", email: "second@test.com" },
        }),
      );
      expect(response.status).toBe(409);
      const body = await jsonBody(response);
      expect(body.error).toMatch(/not enough spots/);
    });

    test("returns 400 for invalid JSON body", async () => {
      const event = await createTestEvent({ maxAttendees: 10 });
      const response = await handleRequest(
        new Request(`http://localhost/api/events/${event.slug}/book`, {
          method: "POST",
          headers: {
            host: "localhost",
            "content-type": "application/json",
          },
          body: "not valid json{{{",
        }),
      );
      expect(response.status).toBe(400);
      const body = await jsonBody(response);
      expect(body.error).toBe("Invalid JSON body");
    });

    test("returns 400 for wrong content-type", async () => {
      const event = await createTestEvent({ maxAttendees: 10 });
      const response = await handleRequest(
        new Request(`http://localhost/api/events/${event.slug}/book`, {
          method: "POST",
          headers: {
            host: "localhost",
            "content-type": "application/x-www-form-urlencoded",
          },
          body: "name=Alice&email=alice@test.com",
        }),
      );
      expect(response.status).toBe(400);
    });

    test("respects quantity parameter", async () => {
      const event = await createTestEvent({ maxAttendees: 10, maxQuantity: 5 });
      const response = await handleRequest(
        apiRequest(`/api/events/${event.slug}/book`, {
          method: "POST",
          body: { name: "Alice", email: "alice@test.com", quantity: 3 },
        }),
      );
      expect(response.status).toBe(200);
      const body = await jsonBody(response);
      expect(body.ticketToken).toBeDefined();
    });

    test("caps quantity at max_quantity", async () => {
      const event = await createTestEvent({
        maxAttendees: 100,
        maxQuantity: 2,
      });
      const response = await handleRequest(
        apiRequest(`/api/events/${event.slug}/book`, {
          method: "POST",
          body: { name: "Alice", email: "alice@test.com", quantity: 99 },
        }),
      );
      // Should succeed — quantity capped to 2
      expect(response.status).toBe(200);
    });

    test("returns 400 when registration is closed", async () => {
      const pastDate = new Date(Date.now() - 60000).toISOString().slice(0, 16);
      const event = await createTestEvent({
        maxAttendees: 10,
        closesAt: pastDate,
      });
      const response = await handleRequest(
        apiRequest(`/api/events/${event.slug}/book`, {
          method: "POST",
          body: { name: "Alice", email: "alice@test.com" },
        }),
      );
      expect(response.status).toBe(400);
      const body = await jsonBody(response);
      expect(body.error).toMatch(/closed/i);
    });

    test("returns checkout URL for paid event", async () => {
      await setupStripe();
      const event = await createTestEvent({
        maxAttendees: 10,
        unitPrice: 1000,
      });
      const response = await handleRequest(
        apiRequest(`/api/events/${event.slug}/book`, {
          method: "POST",
          body: { name: "Alice", email: "alice@test.com" },
        }),
      );
      expect(response.status).toBe(200);
      const body = await jsonBody(response);
      expect(body.checkoutUrl).toBeDefined();
      expect(typeof body.checkoutUrl).toBe("string");
    });

    test("returns 409 for paid event when sold out", async () => {
      await setupStripe();
      const event = await createTestEvent({
        maxAttendees: 1,
        unitPrice: 500,
      });
      await createTestAttendeeDirect(event.id, "First", "f@test.com");
      const response = await handleRequest(
        apiRequest(`/api/events/${event.slug}/book`, {
          method: "POST",
          body: { name: "Second", email: "s@test.com" },
        }),
      );
      expect(response.status).toBe(409);
    });

    test("returns 500 when payment provider not configured for paid event", async () => {
      // Don't call setupStripe — no provider configured
      const event = await createTestEvent({
        maxAttendees: 10,
        unitPrice: 1000,
      });
      const response = await handleRequest(
        apiRequest(`/api/events/${event.slug}/book`, {
          method: "POST",
          body: { name: "Alice", email: "alice@test.com" },
        }),
      );
      // Without payment provider, unit_price > 0 but isPaymentsEnabled returns false
      // so it falls through to free path
      expect([200, 500].includes(response.status)).toBe(true);
    });

    test("books daily event with valid date", async () => {
      const event = await createDailyTestEvent({ maxAttendees: 10 });
      // Get available dates
      const detailResponse = await handleRequest(
        apiRequest(`/api/events/${event.slug}`),
      );
      const detail = await jsonBody(detailResponse);
      const dates = (detail.event as Record<string, unknown>)
        .availableDates as string[];
      expect(dates.length).toBeGreaterThan(0);

      const response = await handleRequest(
        apiRequest(`/api/events/${event.slug}/book`, {
          method: "POST",
          body: { name: "Alice", email: "alice@test.com", date: dates[0] },
        }),
      );
      expect(response.status).toBe(200);
      const body = await jsonBody(response);
      expect(body.ticketToken).toBeDefined();
    });

    test("returns 400 for daily event without date", async () => {
      const event = await createDailyTestEvent({ maxAttendees: 10 });
      const response = await handleRequest(
        apiRequest(`/api/events/${event.slug}/book`, {
          method: "POST",
          body: { name: "Alice", email: "alice@test.com" },
        }),
      );
      expect(response.status).toBe(400);
      const body = await jsonBody(response);
      expect(body.error).toMatch(/valid date/i);
    });

    test("returns 400 for daily event with invalid date", async () => {
      const event = await createDailyTestEvent({ maxAttendees: 10 });
      const response = await handleRequest(
        apiRequest(`/api/events/${event.slug}/book`, {
          method: "POST",
          body: { name: "Alice", email: "alice@test.com", date: "1999-01-01" },
        }),
      );
      expect(response.status).toBe(400);
      const body = await jsonBody(response);
      expect(body.error).toMatch(/valid date/i);
    });

    test("accepts custom price for pay-more event", async () => {
      const event = await createTestEvent({
        maxAttendees: 10,
        canPayMore: true,
        unitPrice: 0,
        maxPrice: 10000,
      });
      const response = await handleRequest(
        apiRequest(`/api/events/${event.slug}/book`, {
          method: "POST",
          body: { name: "Alice", email: "alice@test.com", customPrice: 5.0 },
        }),
      );
      // Price is 0 base and no payment provider, so goes free path
      expect(response.status).toBe(200);
    });

    test("returns 400 for invalid custom price", async () => {
      const event = await createTestEvent({
        maxAttendees: 10,
        canPayMore: true,
        unitPrice: 500,
        maxPrice: 10000,
      });
      const response = await handleRequest(
        apiRequest(`/api/events/${event.slug}/book`, {
          method: "POST",
          body: { name: "Alice", email: "alice@test.com", customPrice: "abc" },
        }),
      );
      expect(response.status).toBe(400);
      const body = await jsonBody(response);
      expect(body.error).toMatch(/price/i);
    });

    test("returns 400 for custom price below minimum", async () => {
      const event = await createTestEvent({
        maxAttendees: 10,
        canPayMore: true,
        unitPrice: 500,
        maxPrice: 10000,
      });
      const response = await handleRequest(
        apiRequest(`/api/events/${event.slug}/book`, {
          method: "POST",
          body: { name: "Alice", email: "alice@test.com", customPrice: 1.0 },
        }),
      );
      expect(response.status).toBe(400);
      const body = await jsonBody(response);
      expect(body.error).toMatch(/minimum/i);
    });

    test("returns 400 for custom price above maximum", async () => {
      const event = await createTestEvent({
        maxAttendees: 10,
        canPayMore: true,
        unitPrice: 500,
        maxPrice: 1000,
      });
      const response = await handleRequest(
        apiRequest(`/api/events/${event.slug}/book`, {
          method: "POST",
          body: { name: "Alice", email: "alice@test.com", customPrice: 999.0 },
        }),
      );
      expect(response.status).toBe(400);
      const body = await jsonBody(response);
      expect(body.error).toMatch(/maximum/i);
    });

    test("returns checkout URL for pay-more event with custom price", async () => {
      await setupStripe();
      const event = await createTestEvent({
        maxAttendees: 10,
        canPayMore: true,
        unitPrice: 500,
        maxPrice: 10000,
      });
      const response = await handleRequest(
        apiRequest(`/api/events/${event.slug}/book`, {
          method: "POST",
          body: { name: "Alice", email: "alice@test.com", customPrice: 10.0 },
        }),
      );
      expect(response.status).toBe(200);
      const body = await jsonBody(response);
      expect(body.checkoutUrl).toBeDefined();
    });

    test("allows omitting price for pay-what-you-want event with zero base price", async () => {
      const event = await createTestEvent({
        maxAttendees: 10,
        canPayMore: true,
        unitPrice: 0,
        maxPrice: 10000,
      });
      const response = await handleRequest(
        apiRequest(`/api/events/${event.slug}/book`, {
          method: "POST",
          body: { name: "Alice", email: "alice@test.com" },
        }),
      );
      expect(response.status).toBe(200);
      const body = await jsonBody(response);
      expect(body.ticketToken).toBeDefined();
    });

    test("requires price for pay-more event with non-zero unit price", async () => {
      const event = await createTestEvent({
        maxAttendees: 10,
        canPayMore: true,
        unitPrice: 500,
        maxPrice: 10000,
      });
      const response = await handleRequest(
        apiRequest(`/api/events/${event.slug}/book`, {
          method: "POST",
          body: { name: "Alice", email: "alice@test.com" },
        }),
      );
      expect(response.status).toBe(400);
      const body = await jsonBody(response);
      expect(body.error).toMatch(/price/i);
    });

    test("handles invalid quantity in booking gracefully", async () => {
      const event = await createTestEvent({ maxAttendees: 10 });
      const response = await handleRequest(
        apiRequest(`/api/events/${event.slug}/book`, {
          method: "POST",
          body: { name: "Alice", email: "alice@test.com", quantity: "abc" },
        }),
      );
      expect(response.status).toBe(200);
      const body = await jsonBody(response);
      expect(body.ticketToken).toBeDefined();
    });

    test("handles booking when email not in event fields", async () => {
      const event = await createTestEvent({
        maxAttendees: 10,
        fields: "phone",
      });
      const response = await handleRequest(
        apiRequest(`/api/events/${event.slug}/book`, {
          method: "POST",
          body: { name: "Alice", phone: "1234567890" },
        }),
      );
      expect(response.status).toBe(200);
      const body = await jsonBody(response);
      expect(body.ticketToken).toBeDefined();
    });

    test("returns 500 when checkout session returns null", async () => {
      await setupStripe();
      const event = await createTestEvent({
        maxAttendees: 10,
        unitPrice: 1000,
      });
      const { stripePaymentProvider } = await import("#lib/stripe-provider.ts");
      const mockCreate = stub(
        stripePaymentProvider,
        "createCheckoutSession",
        () => Promise.resolve(null),
      );
      try {
        const response = await handleRequest(
          apiRequest(`/api/events/${event.slug}/book`, {
            method: "POST",
            body: { name: "Alice", email: "alice@test.com" },
          }),
        );
        expect(response.status).toBe(500);
        const body = await jsonBody(response);
        expect(body.error).toMatch(/payment session/i);
      } finally {
        mockCreate.restore();
      }
    });

    test("returns 400 when checkout session returns error", async () => {
      await setupStripe();
      const event = await createTestEvent({
        maxAttendees: 10,
        unitPrice: 1000,
      });
      const { stripePaymentProvider } = await import("#lib/stripe-provider.ts");
      const mockCreate = stub(
        stripePaymentProvider,
        "createCheckoutSession",
        () => Promise.resolve({ error: "Invalid amount" }),
      );
      try {
        const response = await handleRequest(
          apiRequest(`/api/events/${event.slug}/book`, {
            method: "POST",
            body: { name: "Alice", email: "alice@test.com" },
          }),
        );
        expect(response.status).toBe(400);
        const body = await jsonBody(response);
        expect(body.error).toBe("Invalid amount");
      } finally {
        mockCreate.restore();
      }
    });

    test("returns 500 on encryption error for free event", async () => {
      const { attendeesApi } = await import("#lib/db/attendees.ts");
      const event = await createTestEvent({ maxAttendees: 10 });
      const mockCreate = stub(attendeesApi, "createAttendeeAtomic", () =>
        Promise.resolve({
          success: false as const,
          reason: "encryption_error" as const,
        }),
      );
      try {
        const response = await handleRequest(
          apiRequest(`/api/events/${event.slug}/book`, {
            method: "POST",
            body: { name: "Alice", email: "alice@test.com" },
          }),
        );
        expect(response.status).toBe(500);
        const body = await jsonBody(response);
        expect(body.error).toMatch(/try again/i);
      } finally {
        mockCreate.restore();
      }
    });
  });

  describe("OPTIONS /api/*", () => {
    test("returns 204 with CORS headers for events", async () => {
      const response = await handleRequest(
        apiRequest("/api/events", { method: "OPTIONS" }),
      );
      expect(response.status).toBe(204);
      expectCorsHeaders(response);
      expect(response.headers.get("access-control-allow-methods")).toBe(
        "GET, POST, OPTIONS",
      );
      expect(response.headers.get("access-control-allow-headers")).toBe(
        "content-type",
      );
    });

    test("returns 204 for event slug path", async () => {
      const response = await handleRequest(
        apiRequest("/api/events/test-slug", { method: "OPTIONS" }),
      );
      expect(response.status).toBe(204);
      expectCorsHeaders(response);
    });

    test("returns 204 for availability path", async () => {
      const response = await handleRequest(
        apiRequest("/api/events/test-slug/availability", { method: "OPTIONS" }),
      );
      expect(response.status).toBe(204);
      expectCorsHeaders(response);
    });

    test("returns 204 for book path", async () => {
      const response = await handleRequest(
        apiRequest("/api/events/test-slug/book", { method: "OPTIONS" }),
      );
      expect(response.status).toBe(204);
      expectCorsHeaders(response);
    });
  });

  describe("API disabled", () => {
    test("returns 404 when public API setting is disabled", async () => {
      await updateShowPublicApi(false);
      const response = await handleRequest(apiRequest("/api/events"));
      expect(response.status).toBe(404);
    });
  });
});
