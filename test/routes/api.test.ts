import { expect } from "@std/expect";
import { beforeEach, describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import * as v from "valibot";
import { handleRequest } from "#routes";
import { settings } from "#shared/db/settings.ts";
import { MAX_BOOKING_ATTEMPTS } from "#shared/limits.ts";
import {
  assertJson,
  createDailyTestListing,
  createTestAttendeeDirect,
  createTestGroup,
  createTestListing,
  deactivateTestListing,
  describeWithEnv,
  PublicListingSchema,
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

/** Shape of the public booking endpoint's JSON response (wrapped under `booking`) */
type BookResponseBody = {
  error?: string;
  booking?: {
    ticketToken?: string;
    ticketUrl?: string;
    checkoutUrl?: string;
  };
};

/** Assert CORS headers are present */
const expectCorsHeaders = (response: Response): void => {
  expect(response.headers.get("access-control-allow-origin")).toBe("*");
};

describeWithEnv("Public API", { db: true, triggers: true }, () => {
  beforeEach(async () => {
    await settings.update.showPublicApi(true);
  });

  /** Fetch the listings list and return parsed listings array */
  const fetchListingsList = async (): Promise<{
    response: Response;
    listings: Record<string, unknown>[];
  }> => {
    const response = await handleRequest(apiRequest("/api/listings"));
    const body = await jsonBody(response);
    return { listings: body.listings as Record<string, unknown>[], response };
  };

  /** Fetch a single listing by slug and return parsed listing */
  const fetchListingBySlug = async (
    slug: string,
  ): Promise<{ response: Response; body: Record<string, unknown> }> => {
    const response = await handleRequest(apiRequest(`/api/listings/${slug}`));
    const body = await jsonBody(response);
    return { body, response };
  };

  /** Book an listing by slug with given body fields */
  const bookListing = async (
    slug: string,
    bookingBody: Record<string, unknown> = {
      email: "alice@test.com",
      name: "Alice",
    },
  ): Promise<{ response: Response; body: BookResponseBody }> => {
    const response = await handleRequest(
      apiRequest(`/api/listings/${slug}/book`, {
        body: bookingBody,
        method: "POST",
      }),
    );
    const body = (await jsonBody(response)) as BookResponseBody;
    return { body, response };
  };

  /** Fetch availability for an listing by slug, with optional query string */
  const fetchAvailability = async (
    slug: string,
    query = "",
  ): Promise<{ response: Response; body: Record<string, unknown> }> => {
    const qs = query ? `?${query}` : "";
    const response = await handleRequest(
      apiRequest(`/api/listings/${slug}/availability${qs}`),
    );
    const body = await jsonBody(response);
    return { body, response };
  };

  /** Create a pay-more test listing with standard defaults */
  const createPayMoreListing = (overrides: {
    unitPrice: number;
    maxPrice: number;
    maxAttendees?: number;
  }) =>
    createTestListing({
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
    new Request(`http://localhost/api/listings/${slug}/book`, {
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

  describe("GET /api/listings", () => {
    test("returns empty array when no listings exist", async () => {
      const { response, listings } = await fetchListingsList();
      expect(response.status).toBe(200);
      expect(listings).toEqual([]);
      expectCorsHeaders(response);
    });

    test("returns active non-hidden listings", async () => {
      const listing = await createTestListing({ name: "Public Listing" });
      const { response, listings } = await fetchListingsList();
      expect(response.status).toBe(200);
      expect(listings.length).toBe(1);
      expect(listings[0]!.name).toBe("Public Listing");
      expect(listings[0]!.slug).toBe(listing.slug);
    });

    test("filters hidden listings from listing", async () => {
      await createTestListing({ hidden: false, name: "Visible" });
      await createTestListing({ hidden: true, name: "Hidden" });
      const { listings } = await fetchListingsList();
      expect(listings.length).toBe(1);
      expect(listings[0]!.name).toBe("Visible");
    });

    test("does not expose internal fields", async () => {
      await createTestListing();
      const { listings } = await fetchListingsList();
      // The strict schema requires every public field with the right type and
      // rejects any internal one (id, max_attendees, hidden, …), so a leak —
      // or a missing/mistyped public field — fails the parse.
      expect(() => v.parse(PublicListingSchema, listings[0])).not.toThrow();
    });

    test("sets isSoldOut when listing is at capacity", async () => {
      const listing = await createTestListing({ maxAttendees: 1 });
      await createTestAttendeeDirect(listing.id, "Alice", "a@test.com");
      const { listings } = await fetchListingsList();
      expect(listings[0]!.isSoldOut).toBe(true);
      expect(listings[0]!.maxPurchasable).toBe(0);
    });

    test("sets isSoldOut when sibling listing has filled the group cap", async () => {
      const group = await createTestGroup({
        maxAttendees: 2,
        name: "shared-cap",
        slug: "shared-cap",
      });
      const filler = await createTestListing({
        groupId: group.id,
        maxAttendees: 10,
        name: "Filler",
      });
      const sibling = await createTestListing({
        groupId: group.id,
        maxAttendees: 10,
        name: "Sibling",
      });
      await createTestAttendeeDirect(filler.id, "A", "a@test.com");
      await createTestAttendeeDirect(filler.id, "B", "b@test.com");

      const { listings } = await fetchListingsList();
      const siblingListing = listings.find((e) => e.slug === sibling.slug)!;
      expect(siblingListing.isSoldOut).toBe(true);
      expect(siblingListing.maxPurchasable).toBe(0);
    });

    test("clamps maxPurchasable to remaining group capacity", async () => {
      const group = await createTestGroup({
        maxAttendees: 5,
        name: "tight-cap",
        slug: "tight-cap",
      });
      const filler = await createTestListing({
        groupId: group.id,
        maxAttendees: 10,
        maxQuantity: 1,
        name: "Filler2",
      });
      const sibling = await createTestListing({
        groupId: group.id,
        maxAttendees: 10,
        // Larger than expected group remaining (5 − 3 = 2) so the assertion
        // proves the group clamp, not the per-listing maxQuantity.
        maxQuantity: 10,
        name: "Sibling2",
      });
      await createTestAttendeeDirect(filler.id, "C", "c@test.com");
      await createTestAttendeeDirect(filler.id, "D", "d@test.com");
      await createTestAttendeeDirect(filler.id, "E", "e@test.com");

      const { listings } = await fetchListingsList();
      const siblingListing = listings.find((e) => e.slug === sibling.slug)!;
      expect(siblingListing.isSoldOut).toBe(false);
      expect(siblingListing.maxPurchasable).toBe(2);
    });
  });

  describe("GET /api/listings/:slug", () => {
    test("returns listing details by slug", async () => {
      const listing = await createTestListing({
        description: "Hello",
        name: "My Listing",
      });
      const { response, body } = await fetchListingBySlug(listing.slug);
      expect(response.status).toBe(200);
      const apiListing = v.parse(PublicListingSchema, body.listing);
      expect(apiListing.name).toBe("My Listing");
      expect(apiListing.description).toBe("Hello");
      expectCorsHeaders(response);
    });

    test("returns 404 for non-existent listing", async () => {
      const { response, body } = await fetchListingBySlug("nonexistent");
      expect(response.status).toBe(404);
      expect(body.error).toBe("Listing not found");
    });

    test("exposes customisable days and day prices", async () => {
      const listing = await createTestListing({
        customisableDays: true,
        dayPrices: { 1: 1000, 2: 1800 },
        durationDays: 2,
      });
      const { body } = await fetchListingBySlug(listing.slug);
      const apiListing = v.parse(PublicListingSchema, body.listing);
      expect(apiListing.customisableDays).toBe(true);
      expect(apiListing.dayPrices).toEqual({ 1: 1000, 2: 1800 });
    });

    test("omits day prices for a fixed-duration listing", async () => {
      const listing = await createTestListing({ name: "Fixed" });
      const { body } = await fetchListingBySlug(listing.slug);
      const apiListing = v.parse(PublicListingSchema, body.listing);
      expect(apiListing.customisableDays).toBe(false);
      expect(apiListing.dayPrices).toBeUndefined();
    });

    test("returns 404 for inactive listing", async () => {
      const listing = await createTestListing();
      await deactivateTestListing(listing.id);
      const { response } = await fetchListingBySlug(listing.slug);
      expect(response.status).toBe(404);
    });

    test("allows hidden listings to be accessed by slug", async () => {
      const listing = await createTestListing({
        hidden: true,
        name: "Hidden Listing",
      });
      const { response, body } = await fetchListingBySlug(listing.slug);
      expect(response.status).toBe(200);
      const apiListing = v.parse(PublicListingSchema, body.listing);
      expect(apiListing.name).toBe("Hidden Listing");
    });

    test("includes availableDates for daily listings", async () => {
      const listing = await createDailyTestListing();
      const { response, body } = await fetchListingBySlug(listing.slug);
      expect(response.status).toBe(200);
      const apiListing = v.parse(PublicListingSchema, body.listing);
      expect(apiListing.listingType).toBe("daily");
      expect(Array.isArray(apiListing.availableDates)).toBe(true);
    });

    test("does not include availableDates for standard listings", async () => {
      const listing = await createTestListing();
      const { body } = await fetchListingBySlug(listing.slug);
      const apiListing = v.parse(PublicListingSchema, body.listing);
      expect(apiListing.availableDates).toBeUndefined();
    });
  });

  describe("GET /api/listings/:slug/availability", () => {
    test("returns available true when spots exist", async () => {
      const listing = await createTestListing({ maxAttendees: 10 });
      const { response, body } = await fetchAvailability(listing.slug);
      expect(response.status).toBe(200);
      expect(body.available).toBe(true);
      expectCorsHeaders(response);
    });

    test("returns available false when sold out", async () => {
      const listing = await createTestListing({ maxAttendees: 1 });
      await createTestAttendeeDirect(listing.id, "Alice", "a@test.com");
      const { body } = await fetchAvailability(listing.slug);
      expect(body.available).toBe(false);
    });

    test("respects quantity parameter", async () => {
      const listing = await createTestListing({ maxAttendees: 2 });
      await createTestAttendeeDirect(listing.id, "Alice", "a@test.com");
      // 1 spot left, requesting 2
      const { body } = await fetchAvailability(listing.slug, "quantity=2");
      expect(body.available).toBe(false);
    });

    test("returns 404 for non-existent listing", async () => {
      const { response } = await fetchAvailability("nonexistent");
      expect(response.status).toBe(404);
    });

    test("preserves quantity 0 instead of defaulting to 1", async () => {
      const listing = await createTestListing({ maxAttendees: 10 });
      const { response, body } = await fetchAvailability(
        listing.slug,
        "quantity=0",
      );
      expect(response.status).toBe(200);
      // quantity=0 should be treated as 0, not silently become 1
      expect(body.available).toBe(true);
    });

    test("handles invalid quantity gracefully", async () => {
      const listing = await createTestListing({ maxAttendees: 10 });
      const { response, body } = await fetchAvailability(
        listing.slug,
        "quantity=abc",
      );
      expect(response.status).toBe(200);
      expect(body.available).toBe(true);
    });

    test("does not parse a malformed quantity prefix", async () => {
      const listing = await createTestListing({ maxAttendees: 2 });
      await createTestAttendeeDirect(listing.id, "Alice", "a@test.com");
      const { response, body } = await fetchAvailability(
        listing.slug,
        "quantity=2x",
      );
      expect(response.status).toBe(200);
      expect(body.available).toBe(true);
    });
  });

  describe("POST /api/listings/:slug/book", () => {
    test("creates booking for free listing", async () => {
      const listing = await createTestListing({ maxAttendees: 10 });
      const { response, body } = await bookListing(listing.slug);
      expect(response.status).toBe(200);
      expect(body.booking?.ticketToken).toBeDefined();
      expect(body.booking?.ticketUrl).toBeDefined();
      expect(typeof body.booking?.ticketUrl).toBe("string");
      expectCorsHeaders(response);
    });

    test("rate-limits booking after too many attempts from one IP", async () => {
      const listing = await createTestListing({ maxAttendees: 100 });
      // All test requests share the "direct" fallback IP, so the per-IP counter
      // fills up. The first MAX_BOOKING_ATTEMPTS succeed; the next is blocked.
      for (let i = 0; i < MAX_BOOKING_ATTEMPTS; i++) {
        const { response } = await bookListing(listing.slug, {
          email: `booker${i}@test.com`,
          name: `Booker ${i}`,
        });
        expect(response.status).toBe(200);
      }
      const { response, body } = await bookListing(listing.slug, {
        email: "blocked@test.com",
        name: "Blocked",
      });
      expect(response.status).toBe(429);
      expect(body.error).toMatch(/too many/i);
    });

    test("returns 404 for non-existent listing", async () => {
      const { response } = await bookListing("nonexistent");
      expect(response.status).toBe(404);
    });

    test("rejects customisable-days listings (must book via the website)", async () => {
      const listing = await createTestListing({
        customisableDays: true,
        dayPrices: { 1: 1000, 2: 1800 },
        durationDays: 2,
        maxAttendees: 10,
      });
      const { response, body } = await bookListing(listing.slug, {
        email: "alice@test.com",
        name: "Alice",
      });
      expect(response.status).toBe(400);
      expect(body.error).toContain("website");
    });

    test("returns 400 when required name is missing", async () => {
      const listing = await createTestListing({ maxAttendees: 10 });
      const { response, body } = await bookListing(listing.slug, {
        email: "alice@test.com",
      });
      expect(response.status).toBe(400);
      expect(body.error).toBeDefined();
    });

    test("returns 400 when required email is missing", async () => {
      const listing = await createTestListing({
        fields: "email",
        maxAttendees: 10,
      });
      const { response, body } = await bookListing(listing.slug, {
        name: "Alice",
      });
      expect(response.status).toBe(400);
      expect(body.error).toBeDefined();
    });

    test("returns 409 when listing is at capacity", async () => {
      const listing = await createTestListing({ maxAttendees: 1 });
      await createTestAttendeeDirect(listing.id, "First", "first@test.com");
      const { response, body } = await bookListing(listing.slug, {
        email: "second@test.com",
        name: "Second",
      });
      expect(response.status).toBe(409);
      expect(body.error).toMatch(/not enough spots/);
    });

    test("returns 400 for invalid JSON body", async () => {
      const listing = await createTestListing({ maxAttendees: 10 });
      await assertJson(
        handleRequest(
          rawPostRequest(listing.slug, "application/json", "not valid json{{{"),
        ),
        400,
        (body) => {
          expect(body.error).toBe("Invalid JSON body");
        },
      );
    });

    test("returns 400 for wrong content-type", async () => {
      const listing = await createTestListing({ maxAttendees: 10 });
      const response = await handleRequest(
        rawPostRequest(
          listing.slug,
          "application/x-www-form-urlencoded",
          "name=Alice&email=alice@test.com",
        ),
      );
      expect(response.status).toBe(400);
    });

    test("respects quantity parameter", async () => {
      const listing = await createTestListing({
        maxAttendees: 10,
        maxQuantity: 5,
      });
      const { response, body } = await bookListing(listing.slug, {
        email: "alice@test.com",
        name: "Alice",
        quantity: 3,
      });
      expect(response.status).toBe(200);
      expect(body.booking?.ticketToken).toBeDefined();
    });

    test("caps quantity at max_quantity", async () => {
      const listing = await createTestListing({
        maxAttendees: 100,
        maxQuantity: 2,
      });
      const { response } = await bookListing(listing.slug, {
        email: "alice@test.com",
        name: "Alice",
        quantity: 99,
      });
      // Should succeed — quantity capped to 2
      expect(response.status).toBe(200);
    });

    test("returns 400 when registration is closed", async () => {
      const pastDate = new Date(Date.now() - 60000).toISOString().slice(0, 16);
      const listing = await createTestListing({
        closesAt: pastDate,
        maxAttendees: 10,
      });
      const { response, body } = await bookListing(listing.slug);
      expect(response.status).toBe(400);
      expect(body.error).toMatch(/closed/i);
    });

    test("returns checkout URL for paid listing", async () => {
      await setupStripe();
      const listing = await createTestListing({
        maxAttendees: 10,
        unitPrice: 1000,
      });
      const { response, body } = await bookListing(listing.slug);
      expect(response.status).toBe(200);
      expect(body.booking?.checkoutUrl).toBeDefined();
      expect(typeof body.booking?.checkoutUrl).toBe("string");
    });

    test("returns 409 for paid listing when sold out", async () => {
      await setupStripe();
      const listing = await createTestListing({
        maxAttendees: 1,
        unitPrice: 500,
      });
      await createTestAttendeeDirect(listing.id, "First", "f@test.com");
      const { response } = await bookListing(listing.slug, {
        email: "s@test.com",
        name: "Second",
      });
      expect(response.status).toBe(409);
    });

    test("books a paid listing owing the full value when no payment provider is configured", async () => {
      // Don't call setupStripe — unit_price > 0 but payments are disabled, so
      // the booking is taken without checkout and the full value is recorded as
      // the amount owed (like a zero-deposit reservation), issuing a ticket.
      const listing = await createTestListing({
        maxAttendees: 10,
        unitPrice: 1000,
      });
      const { response, body } = await bookListing(listing.slug);
      expect(response.status).toBe(200);
      const token = body.booking?.ticketToken;
      expect(token).toBeDefined();

      const { getAttendeesByTokens } = await import("#shared/db/attendees.ts");
      const [attendee] = await getAttendeesByTokens([token!]);
      // Nothing collected up front, full £10.00 booking value owed.
      expect(attendee?.remaining_balance).toBe(1000);
      expect(attendee?.bookings[0]?.price_paid).toBe(0);
      // The booking carries the public-default status, matching the web free
      // path so a balance-carrying attendee is never left status-less.
      const { getPublicStatusId } = await import(
        "#shared/db/attendee-statuses.ts"
      );
      expect(attendee?.status_id).toBe(await getPublicStatusId());
    });

    test("books a free listing without an owed balance when a provider is configured", async () => {
      // Payments are enabled but the listing is free, so it takes the no-charge
      // path and owes nothing — the provider is never invoked for checkout.
      await setupStripe();
      const listing = await createTestListing({
        maxAttendees: 10,
        unitPrice: 0,
      });
      const { response, body } = await bookListing(listing.slug);
      expect(response.status).toBe(200);
      const token = body.booking?.ticketToken;
      expect(token).toBeDefined();
      expect(body.booking?.checkoutUrl).toBeUndefined();

      const { getAttendeesByTokens } = await import("#shared/db/attendees.ts");
      const [attendee] = await getAttendeesByTokens([token!]);
      expect(attendee?.remaining_balance).toBe(0);
    });

    test("books daily listing with valid date", async () => {
      const listing = await createDailyTestListing();
      // Get available dates
      const { body: detail } = await fetchListingBySlug(listing.slug);
      const dates =
        v.parse(PublicListingSchema, detail.listing).availableDates ?? [];
      expect(dates.length).toBeGreaterThan(0);

      const { response, body } = await bookListing(listing.slug, {
        date: dates[0],
        email: "alice@test.com",
        name: "Alice",
      });
      expect(response.status).toBe(200);
      expect(body.booking?.ticketToken).toBeDefined();
    });

    test("returns 400 for daily listing without date", async () => {
      const listing = await createDailyTestListing();
      const { response, body } = await bookListing(listing.slug);
      expect(response.status).toBe(400);
      expect(body.error).toMatch(/valid date/i);
    });

    test("returns 400 for daily listing with invalid date", async () => {
      const listing = await createDailyTestListing();
      const { response, body } = await bookListing(listing.slug, {
        date: "1999-01-01",
        email: "alice@test.com",
        name: "Alice",
      });
      expect(response.status).toBe(400);
      expect(body.error).toMatch(/valid date/i);
    });

    test("accepts custom price for pay-more listing", async () => {
      const listing = await createPayMoreListing({
        maxPrice: 10000,
        unitPrice: 0,
      });
      const { response } = await bookListing(listing.slug, {
        customPrice: 5.0,
        email: "alice@test.com",
        name: "Alice",
      });
      // Price is 0 base and no payment provider, so goes free path
      expect(response.status).toBe(200);
    });

    test("returns 400 for invalid custom price", async () => {
      const listing = await createPayMoreListing({
        maxPrice: 10000,
        unitPrice: 500,
      });
      const { response, body } = await bookListing(listing.slug, {
        customPrice: "abc",
        email: "alice@test.com",
        name: "Alice",
      });
      expect(response.status).toBe(400);
      expect(body.error).toMatch(/price/i);
    });

    test("returns 400 for custom price below minimum", async () => {
      const listing = await createPayMoreListing({
        maxPrice: 10000,
        unitPrice: 500,
      });
      const { response, body } = await bookListing(listing.slug, {
        customPrice: 1.0,
        email: "alice@test.com",
        name: "Alice",
      });
      expect(response.status).toBe(400);
      expect(body.error).toMatch(/minimum/i);
    });

    test("returns 400 for custom price above maximum", async () => {
      const listing = await createPayMoreListing({
        maxPrice: 1000,
        unitPrice: 500,
      });
      const { response, body } = await bookListing(listing.slug, {
        customPrice: 999.0,
        email: "alice@test.com",
        name: "Alice",
      });
      expect(response.status).toBe(400);
      expect(body.error).toMatch(/maximum/i);
    });

    test("returns checkout URL for pay-more listing with custom price", async () => {
      await setupStripe();
      const listing = await createPayMoreListing({
        maxPrice: 10000,
        unitPrice: 500,
      });
      const { response, body } = await bookListing(listing.slug, {
        customPrice: 10.0,
        email: "alice@test.com",
        name: "Alice",
      });
      expect(response.status).toBe(200);
      expect(body.booking?.checkoutUrl).toBeDefined();
    });

    test("allows omitting price for pay-what-you-want listing with zero base price", async () => {
      const listing = await createPayMoreListing({
        maxPrice: 10000,
        unitPrice: 0,
      });
      const { response, body } = await bookListing(listing.slug);
      expect(response.status).toBe(200);
      expect(body.booking?.ticketToken).toBeDefined();
    });

    test("requires price for pay-more listing with non-zero unit price", async () => {
      const listing = await createPayMoreListing({
        maxPrice: 10000,
        unitPrice: 500,
      });
      const { response, body } = await bookListing(listing.slug);
      expect(response.status).toBe(400);
      expect(body.error).toMatch(/price/i);
    });

    test("handles invalid quantity in booking gracefully", async () => {
      const listing = await createTestListing({ maxAttendees: 10 });
      const { response, body } = await bookListing(listing.slug, {
        email: "alice@test.com",
        name: "Alice",
        quantity: "abc",
      });
      expect(response.status).toBe(200);
      expect(body.booking?.ticketToken).toBeDefined();
    });

    test("does not parse a malformed booking quantity prefix", async () => {
      const listing = await createTestListing({ maxAttendees: 10 });
      const { response } = await bookListing(listing.slug, {
        email: "alice@test.com",
        name: "Alice",
        quantity: "2x",
      });
      expect(response.status).toBe(200);

      const { getAttendeesRaw } = await import("#shared/db/attendees.ts");
      const attendees = await getAttendeesRaw(listing.id);
      expect(attendees[0]!.quantity).toBe(1);
    });

    test("handles booking when email not in listing fields", async () => {
      const listing = await createTestListing({
        fields: "phone",
        maxAttendees: 10,
      });
      const { response, body } = await bookListing(listing.slug, {
        name: "Alice",
        phone: "1234567890",
      });
      expect(response.status).toBe(200);
      expect(body.booking?.ticketToken).toBeDefined();
    });

    test("returns 500 when checkout session returns null", async () => {
      await setupStripe();
      const listing = await createTestListing({
        maxAttendees: 10,
        unitPrice: 1000,
      });
      await withCheckoutStub(null, async () => {
        const { response, body } = await bookListing(listing.slug);
        expect(response.status).toBe(500);
        expect(body.error).toMatch(/payment session/i);
      });
    });

    test("returns 400 when checkout session returns error", async () => {
      await setupStripe();
      const listing = await createTestListing({
        maxAttendees: 10,
        unitPrice: 1000,
      });
      await withCheckoutStub({ error: "Invalid amount" }, async () => {
        const { response, body } = await bookListing(listing.slug);
        expect(response.status).toBe(400);
        expect(body.error).toBe("Invalid amount");
      });
    });

    test("returns 500 on encryption error for free listing", async () => {
      const { attendeesApi } = await import("#shared/db/attendees.ts");
      const listing = await createTestListing({ maxAttendees: 10 });
      const mockCreate = stub(attendeesApi, "createAttendeeAtomic", () =>
        Promise.resolve({
          reason: "encryption_error" as const,
          success: false as const,
        }),
      );
      try {
        const { response, body } = await bookListing(listing.slug);
        expect(response.status).toBe(500);
        expect(body.error).toMatch(/try again/i);
      } finally {
        mockCreate.restore();
      }
    });
  });

  describe("OPTIONS /api/*", () => {
    test("returns 204 with CORS headers for listings", async () => {
      const response = await handleRequest(
        apiRequest("/api/listings", { method: "OPTIONS" }),
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

    test("returns 204 for listing slug path", async () => {
      const response = await handleRequest(
        apiRequest("/api/listings/test-slug", { method: "OPTIONS" }),
      );
      expect(response.status).toBe(204);
      expectCorsHeaders(response);
    });

    test("returns 204 for availability path", async () => {
      const response = await handleRequest(
        apiRequest("/api/listings/test-slug/availability", {
          method: "OPTIONS",
        }),
      );
      expect(response.status).toBe(204);
      expectCorsHeaders(response);
    });

    test("returns 204 for book path", async () => {
      const response = await handleRequest(
        apiRequest("/api/listings/test-slug/book", { method: "OPTIONS" }),
      );
      expect(response.status).toBe(204);
      expectCorsHeaders(response);
    });
  });

  describe("API disabled", () => {
    test("returns 404 when public API setting is disabled", async () => {
      await settings.update.showPublicApi(false);
      const response = await handleRequest(apiRequest("/api/listings"));
      expect(response.status).toBe(404);
    });
  });

  describe("booking listing_id manipulation", () => {
    test("ignores listing_id in JSON body", async () => {
      const target = await createTestListing({ maxAttendees: 50 });
      const other = await createTestListing({ maxAttendees: 50 });

      const { response } = await bookListing(target.slug, {
        email: "mallory@example.com",
        listing_id: other.id,
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

    test("returns 404 for non-existent slug even with valid listing_id in body", async () => {
      const listing = await createTestListing({ maxAttendees: 50 });

      const { response } = await bookListing("nonexistent", {
        email: "mallory@example.com",
        listing_id: listing.id,
        name: "Mallory",
      });
      expect(response.status).toBe(404);

      // Verify no booking was created
      const { getAttendeesRaw } = await import("#shared/db/attendees.ts");
      const attendees = await getAttendeesRaw(listing.id);
      expect(attendees.length).toBe(0);
    });

    test("ignores slug field in JSON body", async () => {
      const target = await createTestListing({ maxAttendees: 50 });
      const other = await createTestListing({ maxAttendees: 50 });

      const { response } = await bookListing(target.slug, {
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
