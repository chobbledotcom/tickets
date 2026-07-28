import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import * as v from "valibot";
import {
  bookForToken,
  bookListing,
  createPayMoreListing,
  describePublicApi,
  fetchListingBySlug,
  withCheckoutStub,
} from "#test/test-utils/api/helpers.ts";
import { PublicListingDetailSchema } from "#test-utils/api-schemas.ts";
import { createTestAttendeeDirect } from "#test-utils/db-helpers/attendees.ts";
import {
  createDailyTestListing,
  createTestListing,
} from "#test-utils/db-helpers/listings.ts";
import { setupStripe } from "#test-utils/settings.ts";

describePublicApi(() => {
  describe("POST /api/listings/:slug/book", () => {
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
      const body = await bookForToken(listing.slug);
      const token = body.booking?.ticketToken;
      // The response surfaces the owed amount so integrations can collect it.
      expect(body.booking?.amountOwed).toBe(1000);

      const { getAttendeesByTokens } = await import(
        "#shared/db/attendees/tokens.ts"
      );
      const [attendee] = await getAttendeesByTokens([token!]);
      // Nothing collected up front, full £10.00 booking value owed. price_paid
      // projects the gross sale leg (£10 billed), not cash collected — the
      // accepted gross-sale divergence; the £10 owed is exact.
      expect(attendee?.remaining_balance).toBe(1000);
      expect(attendee?.bookings[0]?.price_paid).toBe(1000);
      // The booking carries the public-default status, matching the web free
      // path so a balance-carrying attendee is never left status-less.
      const { requirePublicStatusId } = await import(
        "#shared/db/attendee-statuses.ts"
      );
      expect(attendee?.status_id).toBe(await requirePublicStatusId());
    });

    test("books a free listing without an owed balance when a provider is configured", async () => {
      // Payments are enabled but the listing is free, so it takes the no-charge
      // path and owes nothing — the provider is never invoked for checkout.
      await setupStripe();
      const listing = await createTestListing({
        maxAttendees: 10,
        unitPrice: 0,
      });
      const body = await bookForToken(listing.slug);
      const token = body.booking?.ticketToken;
      expect(body.booking?.checkoutUrl).toBeUndefined();

      const { getAttendeesByTokens } = await import(
        "#shared/db/attendees/tokens.ts"
      );
      const [attendee] = await getAttendeesByTokens([token!]);
      expect(attendee?.remaining_balance).toBe(0);
    });

    test("books daily listing with valid date", async () => {
      const listing = await createDailyTestListing();
      // Get available dates
      const { body: detail } = await fetchListingBySlug(listing.slug);
      const dates =
        v.parse(PublicListingDetailSchema, detail.listing).availableDates ?? [];
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

      const { getAttendeesRaw } = await import(
        "#shared/db/attendees/queries.ts"
      );
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
  });
});
