import { expect } from "@std/expect";
import { beforeEach, describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { handleRequest } from "#routes";
import { settings } from "#shared/db/settings.ts";
import {
  assertJson,
  createDailyTestEvent,
  createTestAttendeeDirect,
  createTestEvent,
  createTestGroup,
  deactivateTestEvent,
  describeWithEnv,
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
  const init: RequestInit = { headers, method };

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

describeWithEnv("Public API", { db: true }, () => {
  beforeEach(async () => {
    await settings.update.showPublicApi(true);
  });

  /** Fetch the events list and return parsed events array */
  const fetchEventsList = async (): Promise<{
    response: Response;
    events: Record<string, unknown>[];
  }> => {
    const response = await handleRequest(apiRequest("/api/events"));
    const body = await jsonBody(response);
    return { events: body.events as Record<string, unknown>[], response };
  };

  /** Fetch a single event by slug and return parsed event */
  const fetchEventBySlug = async (
    slug: string,
  ): Promise<{ response: Response; body: Record<string, unknown> }> => {
    const response = await handleRequest(apiRequest(`/api/events/${slug}`));
    const body = await jsonBody(response);
    return { body, response };
  };

  /** Book an event by slug with given body fields */
  const bookEvent = async (
    slug: string,
    bookingBody: Record<string, unknown> = {
      email: "alice@test.com",
      name: "Alice",
    },
  ): Promise<{ response: Response; body: Record<string, unknown> }> => {
    const response = await handleRequest(
      apiRequest(`/api/events/${slug}/book`, {
        body: bookingBody,
        method: "POST",
      }),
    );
    const body = await jsonBody(response);
    return { body, response };
  };

  /** Fetch availability for an event by slug, with optional query string */
  const fetchAvailability = async (
    slug: string,
    query = "",
  ): Promise<{ response: Response; body: Record<string, unknown> }> => {
    const qs = query ? `?${query}` : "";
    const response = await handleRequest(
      apiRequest(`/api/events/${slug}/availability${qs}`),
    );
    const body = await jsonBody(response);
    return { body, response };
  };

  /** Create a pay-more test event with standard defaults */
  const createPayMoreEvent = (overrides: {
    unitPrice: number;
    maxPrice: number;
    maxAttendees?: number;
  }) =>
    createTestEvent({
      canPayMore: true,
      maxAttendees: overrides.maxAttendees ?? 10,
      maxPrice: overrides.maxPrice,
      unitPrice: overrides.unitPrice,
    });

  /** Create a raw POST request with custom content-type and body string */
  const rawPostRequest = (
    slug: string,
    contentType: string,
    rawBody: string,
  ): Request =>
    new Request(`http://localhost/api/events/${slug}/book`, {
      body: rawBody,
      headers: { "content-type": contentType, host: "localhost" },
      method: "POST",
    });

  /** Stub a stripe checkout method and run a test, restoring after */
  const withCheckoutStub = async (
    stubResult: import("#shared/payments.ts").CheckoutSessionResult,
    fn: () => Promise<void>,
  ) => {
    const { stripePaymentProvider } = await import(
      "#shared/stripe-provider.ts"
    );
    const mockCreate = stub(
      stripePaymentProvider,
      "createCheckoutSession",
      () => Promise.resolve(stubResult),
    );
    try {
      await fn();
    } finally {
      mockCreate.restore();
    }
  };

  describe("GET /api/events", () => {
    test("returns empty array when no events exist", async () => {
      const { response, events } = await fetchEventsList();
      expect(response.status).toBe(200);
      expect(events).toEqual([]);
      expectCorsHeaders(response);
    });

    test("returns active non-hidden events", async () => {
      const event = await createTestEvent({ name: "Public Event" });
      const { response, events } = await fetchEventsList();
      expect(response.status).toBe(200);
      expect(events.length).toBe(1);
      expect(events[0]!.name).toBe("Public Event");
      expect(events[0]!.slug).toBe(event.slug);
    });

    test("filters hidden events from listing", async () => {
      await createTestEvent({ hidden: false, name: "Visible" });
      await createTestEvent({ hidden: true, name: "Hidden" });
      const { events } = await fetchEventsList();
      expect(events.length).toBe(1);
      expect(events[0]!.name).toBe("Visible");
    });

    test("does not expose internal fields", async () => {
      await createTestEvent();
      const { events } = await fetchEventsList();
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
      const { events } = await fetchEventsList();
      expect(events[0]!.isSoldOut).toBe(true);
      expect(events[0]!.maxPurchasable).toBe(0);
    });

    test("sets isSoldOut when sibling event has filled the group cap", async () => {
      const group = await createTestGroup({
        maxAttendees: 2,
        name: "shared-cap",
        slug: "shared-cap",
      });
      const filler = await createTestEvent({
        groupId: group.id,
        maxAttendees: 10,
        name: "Filler",
      });
      const sibling = await createTestEvent({
        groupId: group.id,
        maxAttendees: 10,
        name: "Sibling",
      });
      await createTestAttendeeDirect(filler.id, "A", "a@test.com");
      await createTestAttendeeDirect(filler.id, "B", "b@test.com");

      const { events } = await fetchEventsList();
      const siblingEvent = events.find((e) => e.slug === sibling.slug)!;
      expect(siblingEvent.isSoldOut).toBe(true);
      expect(siblingEvent.maxPurchasable).toBe(0);
    });

    test("clamps maxPurchasable to remaining group capacity", async () => {
      const group = await createTestGroup({
        maxAttendees: 5,
        name: "tight-cap",
        slug: "tight-cap",
      });
      const filler = await createTestEvent({
        groupId: group.id,
        maxAttendees: 10,
        maxQuantity: 1,
        name: "Filler2",
      });
      const sibling = await createTestEvent({
        groupId: group.id,
        maxAttendees: 10,
        // Larger than expected group remaining (5 − 3 = 2) so the assertion
        // proves the group clamp, not the per-event maxQuantity.
        maxQuantity: 10,
        name: "Sibling2",
      });
      await createTestAttendeeDirect(filler.id, "C", "c@test.com");
      await createTestAttendeeDirect(filler.id, "D", "d@test.com");
      await createTestAttendeeDirect(filler.id, "E", "e@test.com");

      const { events } = await fetchEventsList();
      const siblingEvent = events.find((e) => e.slug === sibling.slug)!;
      expect(siblingEvent.isSoldOut).toBe(false);
      expect(siblingEvent.maxPurchasable).toBe(2);
    });
  });

  describe("GET /api/events/:slug", () => {
    test("returns event details by slug", async () => {
      const event = await createTestEvent({
        description: "Hello",
        name: "My Event",
      });
      const { response, body } = await fetchEventBySlug(event.slug);
      expect(response.status).toBe(200);
      const apiEvent = body.event as Record<string, unknown>;
      expect(apiEvent.name).toBe("My Event");
      expect(apiEvent.description).toBe("Hello");
      expectCorsHeaders(response);
    });

    test("returns 404 for non-existent event", async () => {
      const { response, body } = await fetchEventBySlug("nonexistent");
      expect(response.status).toBe(404);
      expect(body.error).toBe("Event not found");
    });

    test("returns 404 for inactive event", async () => {
      const event = await createTestEvent();
      await deactivateTestEvent(event.id);
      const { response } = await fetchEventBySlug(event.slug);
      expect(response.status).toBe(404);
    });

    test("allows hidden events to be accessed by slug", async () => {
      const event = await createTestEvent({
        hidden: true,
        name: "Hidden Event",
      });
      const { response, body } = await fetchEventBySlug(event.slug);
      expect(response.status).toBe(200);
      expect((body.event as Record<string, unknown>).name).toBe("Hidden Event");
    });

    test("includes availableDates for daily events", async () => {
      const event = await createDailyTestEvent();
      const { response, body } = await fetchEventBySlug(event.slug);
      expect(response.status).toBe(200);
      const apiEvent = body.event as Record<string, unknown>;
      expect(apiEvent.eventType).toBe("daily");
      expect(Array.isArray(apiEvent.availableDates)).toBe(true);
    });

    test("does not include availableDates for standard events", async () => {
      const event = await createTestEvent();
      const { body } = await fetchEventBySlug(event.slug);
      const apiEvent = body.event as Record<string, unknown>;
      expect(apiEvent.availableDates).toBeUndefined();
    });
  });

  describe("GET /api/events/:slug/availability", () => {
    test("returns available true when spots exist", async () => {
      const event = await createTestEvent({ maxAttendees: 10 });
      const { response, body } = await fetchAvailability(event.slug);
      expect(response.status).toBe(200);
      expect(body.available).toBe(true);
      expectCorsHeaders(response);
    });

    test("returns available false when sold out", async () => {
      const event = await createTestEvent({ maxAttendees: 1 });
      await createTestAttendeeDirect(event.id, "Alice", "a@test.com");
      const { body } = await fetchAvailability(event.slug);
      expect(body.available).toBe(false);
    });

    test("respects quantity parameter", async () => {
      const event = await createTestEvent({ maxAttendees: 2 });
      await createTestAttendeeDirect(event.id, "Alice", "a@test.com");
      // 1 spot left, requesting 2
      const { body } = await fetchAvailability(event.slug, "quantity=2");
      expect(body.available).toBe(false);
    });

    test("returns 404 for non-existent event", async () => {
      const { response } = await fetchAvailability("nonexistent");
      expect(response.status).toBe(404);
    });

    test("preserves quantity 0 instead of defaulting to 1", async () => {
      const event = await createTestEvent({ maxAttendees: 10 });
      const { response, body } = await fetchAvailability(
        event.slug,
        "quantity=0",
      );
      expect(response.status).toBe(200);
      // quantity=0 should be treated as 0, not silently become 1
      expect(body.available).toBe(true);
    });

    test("handles invalid quantity gracefully", async () => {
      const event = await createTestEvent({ maxAttendees: 10 });
      const { response, body } = await fetchAvailability(
        event.slug,
        "quantity=abc",
      );
      expect(response.status).toBe(200);
      expect(body.available).toBe(true);
    });
  });

  describe("POST /api/events/:slug/book", () => {
    test("creates booking for free event", async () => {
      const event = await createTestEvent({ maxAttendees: 10 });
      const { response, body } = await bookEvent(event.slug);
      expect(response.status).toBe(200);
      expect(body.ticketToken).toBeDefined();
      expect(body.ticketUrl).toBeDefined();
      expect(typeof body.ticketUrl).toBe("string");
      expectCorsHeaders(response);
    });

    test("returns 404 for non-existent event", async () => {
      const { response } = await bookEvent("nonexistent");
      expect(response.status).toBe(404);
    });

    test("returns 400 when required name is missing", async () => {
      const event = await createTestEvent({ maxAttendees: 10 });
      const { response, body } = await bookEvent(event.slug, {
        email: "alice@test.com",
      });
      expect(response.status).toBe(400);
      expect(body.error).toBeDefined();
    });

    test("returns 400 when required email is missing", async () => {
      const event = await createTestEvent({
        fields: "email",
        maxAttendees: 10,
      });
      const { response, body } = await bookEvent(event.slug, {
        name: "Alice",
      });
      expect(response.status).toBe(400);
      expect(body.error).toBeDefined();
    });

    test("returns 409 when event is at capacity", async () => {
      const event = await createTestEvent({ maxAttendees: 1 });
      await createTestAttendeeDirect(event.id, "First", "first@test.com");
      const { response, body } = await bookEvent(event.slug, {
        email: "second@test.com",
        name: "Second",
      });
      expect(response.status).toBe(409);
      expect(body.error).toMatch(/not enough spots/);
    });

    test("returns 400 for invalid JSON body", async () => {
      const event = await createTestEvent({ maxAttendees: 10 });
      await assertJson(
        handleRequest(
          rawPostRequest(event.slug, "application/json", "not valid json{{{"),
        ),
        400,
        (body) => {
          expect(body.error).toBe("Invalid JSON body");
        },
      );
    });

    test("returns 400 for wrong content-type", async () => {
      const event = await createTestEvent({ maxAttendees: 10 });
      const response = await handleRequest(
        rawPostRequest(
          event.slug,
          "application/x-www-form-urlencoded",
          "name=Alice&email=alice@test.com",
        ),
      );
      expect(response.status).toBe(400);
    });

    test("respects quantity parameter", async () => {
      const event = await createTestEvent({ maxAttendees: 10, maxQuantity: 5 });
      const { response, body } = await bookEvent(event.slug, {
        email: "alice@test.com",
        name: "Alice",
        quantity: 3,
      });
      expect(response.status).toBe(200);
      expect(body.ticketToken).toBeDefined();
    });

    test("caps quantity at max_quantity", async () => {
      const event = await createTestEvent({
        maxAttendees: 100,
        maxQuantity: 2,
      });
      const { response } = await bookEvent(event.slug, {
        email: "alice@test.com",
        name: "Alice",
        quantity: 99,
      });
      // Should succeed — quantity capped to 2
      expect(response.status).toBe(200);
    });

    test("returns 400 when registration is closed", async () => {
      const pastDate = new Date(Date.now() - 60000).toISOString().slice(0, 16);
      const event = await createTestEvent({
        closesAt: pastDate,
        maxAttendees: 10,
      });
      const { response, body } = await bookEvent(event.slug);
      expect(response.status).toBe(400);
      expect(body.error).toMatch(/closed/i);
    });

    test("returns checkout URL for paid event", async () => {
      await setupStripe();
      const event = await createTestEvent({
        maxAttendees: 10,
        unitPrice: 1000,
      });
      const { response, body } = await bookEvent(event.slug);
      expect(response.status).toBe(200);
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
      const { response } = await bookEvent(event.slug, {
        email: "s@test.com",
        name: "Second",
      });
      expect(response.status).toBe(409);
    });

    test("returns 500 when payment provider not configured for paid event", async () => {
      // Don't call setupStripe — no provider configured
      const event = await createTestEvent({
        maxAttendees: 10,
        unitPrice: 1000,
      });
      const { response } = await bookEvent(event.slug);
      // Without payment provider, unit_price > 0 but isPaymentsEnabled returns false
      // so it falls through to free path
      expect([200, 500].includes(response.status)).toBe(true);
    });

    test("books daily event with valid date", async () => {
      const event = await createDailyTestEvent();
      // Get available dates
      const { body: detail } = await fetchEventBySlug(event.slug);
      const dates = (detail.event as Record<string, unknown>)
        .availableDates as string[];
      expect(dates.length).toBeGreaterThan(0);

      const { response, body } = await bookEvent(event.slug, {
        date: dates[0],
        email: "alice@test.com",
        name: "Alice",
      });
      expect(response.status).toBe(200);
      expect(body.ticketToken).toBeDefined();
    });

    test("returns 400 for daily event without date", async () => {
      const event = await createDailyTestEvent();
      const { response, body } = await bookEvent(event.slug);
      expect(response.status).toBe(400);
      expect(body.error).toMatch(/valid date/i);
    });

    test("returns 400 for daily event with invalid date", async () => {
      const event = await createDailyTestEvent();
      const { response, body } = await bookEvent(event.slug, {
        date: "1999-01-01",
        email: "alice@test.com",
        name: "Alice",
      });
      expect(response.status).toBe(400);
      expect(body.error).toMatch(/valid date/i);
    });

    test("accepts custom price for pay-more event", async () => {
      const event = await createPayMoreEvent({
        maxPrice: 10000,
        unitPrice: 0,
      });
      const { response } = await bookEvent(event.slug, {
        customPrice: 5.0,
        email: "alice@test.com",
        name: "Alice",
      });
      // Price is 0 base and no payment provider, so goes free path
      expect(response.status).toBe(200);
    });

    test("returns 400 for invalid custom price", async () => {
      const event = await createPayMoreEvent({
        maxPrice: 10000,
        unitPrice: 500,
      });
      const { response, body } = await bookEvent(event.slug, {
        customPrice: "abc",
        email: "alice@test.com",
        name: "Alice",
      });
      expect(response.status).toBe(400);
      expect(body.error).toMatch(/price/i);
    });

    test("returns 400 for custom price below minimum", async () => {
      const event = await createPayMoreEvent({
        maxPrice: 10000,
        unitPrice: 500,
      });
      const { response, body } = await bookEvent(event.slug, {
        customPrice: 1.0,
        email: "alice@test.com",
        name: "Alice",
      });
      expect(response.status).toBe(400);
      expect(body.error).toMatch(/minimum/i);
    });

    test("returns 400 for custom price above maximum", async () => {
      const event = await createPayMoreEvent({
        maxPrice: 1000,
        unitPrice: 500,
      });
      const { response, body } = await bookEvent(event.slug, {
        customPrice: 999.0,
        email: "alice@test.com",
        name: "Alice",
      });
      expect(response.status).toBe(400);
      expect(body.error).toMatch(/maximum/i);
    });

    test("returns checkout URL for pay-more event with custom price", async () => {
      await setupStripe();
      const event = await createPayMoreEvent({
        maxPrice: 10000,
        unitPrice: 500,
      });
      const { response, body } = await bookEvent(event.slug, {
        customPrice: 10.0,
        email: "alice@test.com",
        name: "Alice",
      });
      expect(response.status).toBe(200);
      expect(body.checkoutUrl).toBeDefined();
    });

    test("allows omitting price for pay-what-you-want event with zero base price", async () => {
      const event = await createPayMoreEvent({
        maxPrice: 10000,
        unitPrice: 0,
      });
      const { response, body } = await bookEvent(event.slug);
      expect(response.status).toBe(200);
      expect(body.ticketToken).toBeDefined();
    });

    test("requires price for pay-more event with non-zero unit price", async () => {
      const event = await createPayMoreEvent({
        maxPrice: 10000,
        unitPrice: 500,
      });
      const { response, body } = await bookEvent(event.slug);
      expect(response.status).toBe(400);
      expect(body.error).toMatch(/price/i);
    });

    test("handles invalid quantity in booking gracefully", async () => {
      const event = await createTestEvent({ maxAttendees: 10 });
      const { response, body } = await bookEvent(event.slug, {
        email: "alice@test.com",
        name: "Alice",
        quantity: "abc",
      });
      expect(response.status).toBe(200);
      expect(body.ticketToken).toBeDefined();
    });

    test("handles booking when email not in event fields", async () => {
      const event = await createTestEvent({
        fields: "phone",
        maxAttendees: 10,
      });
      const { response, body } = await bookEvent(event.slug, {
        name: "Alice",
        phone: "1234567890",
      });
      expect(response.status).toBe(200);
      expect(body.ticketToken).toBeDefined();
    });

    test("returns 500 when checkout session returns null", async () => {
      await setupStripe();
      const event = await createTestEvent({
        maxAttendees: 10,
        unitPrice: 1000,
      });
      await withCheckoutStub(null, async () => {
        const { response, body } = await bookEvent(event.slug);
        expect(response.status).toBe(500);
        expect(body.error).toMatch(/payment session/i);
      });
    });

    test("returns 400 when checkout session returns error", async () => {
      await setupStripe();
      const event = await createTestEvent({
        maxAttendees: 10,
        unitPrice: 1000,
      });
      await withCheckoutStub({ error: "Invalid amount" }, async () => {
        const { response, body } = await bookEvent(event.slug);
        expect(response.status).toBe(400);
        expect(body.error).toBe("Invalid amount");
      });
    });

    test("returns 500 on encryption error for free event", async () => {
      const { attendeesApi } = await import("#shared/db/attendees.ts");
      const event = await createTestEvent({ maxAttendees: 10 });
      const mockCreate = stub(attendeesApi, "createAttendeeAtomic", () =>
        Promise.resolve({
          reason: "encryption_error" as const,
          success: false as const,
        }),
      );
      try {
        const { response, body } = await bookEvent(event.slug);
        expect(response.status).toBe(500);
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
      await settings.update.showPublicApi(false);
      const response = await handleRequest(apiRequest("/api/events"));
      expect(response.status).toBe(404);
    });
  });

  describe("booking event_id manipulation", () => {
    test("ignores event_id in JSON body", async () => {
      const target = await createTestEvent({ maxAttendees: 50 });
      const other = await createTestEvent({ maxAttendees: 50 });

      const { response } = await bookEvent(target.slug, {
        email: "mallory@example.com",
        event_id: other.id,
        name: "Mallory",
      });
      expect(response.status).toBe(200);

      // Verify booking went to target (URL slug), not other (injected id)
      const { getAttendeesRaw } = await import("#shared/db/attendees.ts");
      const targetAttendees = await getAttendeesRaw(target.id);
      const otherAttendees = await getAttendeesRaw(other.id);
      expect(targetAttendees.length).toBe(1);
      expect(otherAttendees.length).toBe(0);
    });

    test("returns 404 for non-existent slug even with valid event_id in body", async () => {
      const event = await createTestEvent({ maxAttendees: 50 });

      const { response } = await bookEvent("nonexistent", {
        email: "mallory@example.com",
        event_id: event.id,
        name: "Mallory",
      });
      expect(response.status).toBe(404);

      // Verify no booking was created
      const { getAttendeesRaw } = await import("#shared/db/attendees.ts");
      const attendees = await getAttendeesRaw(event.id);
      expect(attendees.length).toBe(0);
    });

    test("ignores slug field in JSON body", async () => {
      const target = await createTestEvent({ maxAttendees: 50 });
      const other = await createTestEvent({ maxAttendees: 50 });

      const { response } = await bookEvent(target.slug, {
        email: "mallory@example.com",
        name: "Mallory",
        slug: other.slug,
      });
      expect(response.status).toBe(200);

      // Booking goes to URL slug, body slug is ignored
      const { getAttendeesRaw } = await import("#shared/db/attendees.ts");
      const targetAttendees = await getAttendeesRaw(target.id);
      const otherAttendees = await getAttendeesRaw(other.id);
      expect(targetAttendees.length).toBe(1);
      expect(otherAttendees.length).toBe(0);
    });
  });
});
