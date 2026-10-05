import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { MAX_BOOKING_ATTEMPTS } from "#shared/limits.ts";
import {
  bookListing,
  describePublicApi,
  expectCorsHeaders,
  rawPostRequest,
} from "#test-utils/api/helpers.ts";
import { assertJson } from "#test-utils/assertions.ts";
import { createTestAttendeeDirect } from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";

describePublicApi(() => {
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

    test("rejects an explicit quantity of 0 instead of booking one ticket", async () => {
      const listing = await createTestListing({ maxAttendees: 10 });
      const { response, body } = await bookListing(listing.slug, {
        email: "zero@test.com",
        name: "Zero",
        quantity: 0,
      });
      // A quantity-0 line is admin-only — the public API must never coerce 0 to a
      // one-ticket booking.
      expect(response.status).toBe(400);
      expect(body.error).toMatch(/quantity/i);
      const { getAttendeesRaw } = await import("#db/attendees/queries.ts");
      expect((await getAttendeesRaw(listing.id)).length).toBe(0);
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
  });
});
