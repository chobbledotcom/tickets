import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  type BookingResult,
  listingHasSpots,
  processBooking,
} from "#shared/booking.ts";
import { getAttendeeBalanceState } from "#shared/db/attendees/balance.ts";
import type { Attendee, ContactInfo } from "#shared/types.ts";
import { withCheckoutStub } from "#test/routes/api/helpers.ts";
import { STUB_CHECKOUT_URL, stubCheckout } from "#test-utils/checkout.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestAttendeeDirect } from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { setupStripe } from "#test-utils/settings.ts";

/** Direct, function-level tests of {@link processBooking} and
 * {@link listingHasSpots} — the single-listing booking core. The route layer
 * (`handleBook`) maps a {@link BookingResult} to a JSON response, so these tests
 * pin the discriminated-union contract the route depends on at the function
 * boundary rather than going through the HTTP/router stack. */
const BASE_URL = "http://localhost";

const contact: ContactInfo = {
  address: "",
  email: "alice@test.com",
  name: "Alice",
  phone: "",
  special_instructions: "",
};

/** Narrow a {@link BookingResult} to its success attendee, or null. The caller
 * first asserts `result.type === "success"` (which throws on a wrong branch),
 * so a null here means the branch drifted — the value assertion then fails
 * loudly rather than papering over the mismatch. */
const attendeeOf = (result: BookingResult) =>
  result.type === "success" ? result.attendee : null;

/** Create a listing at `unitPrice` (capacity 10) and book `quantity` units
 *  directly, asserting success and returning the attendee. Shared by the free,
 *  owed, scaled, and one-penny success-path tests. */
const bookDirect = async (
  unitPrice: number,
  quantity = 1,
): Promise<Attendee> => {
  const listing = await createTestListing({ maxAttendees: 10, unitPrice });
  const result = await processBooking(
    listing,
    contact,
    quantity,
    null,
    BASE_URL,
  );
  expect(result.type).toBe("success");
  return attendeeOf(result)!;
};

describeWithEnv("processBooking", { db: true, triggers: true }, () => {
  describe("free and provider-less direct bookings", () => {
    test("creates a free attendee that owes nothing", async () => {
      const attendee = await bookDirect(0);
      expect(attendee.remaining_balance).toBe(0);
      expect(typeof attendee.ticket_token).toBe("string");
      expect(attendee.ticket_token.length).toBeGreaterThan(0);
    });

    test("records the full listing value as owed without a provider", async () => {
      const attendee = await bookDirect(1500);
      expect(attendee.remaining_balance).toBe(1500);
      // The owed ledger poster writes a gross `sale` leg with nothing paid, so
      // the ledger-projected balance (not just the denormalized column) equals
      // the gross — the invariant the poster exists to maintain.
      expect(
        (await getAttendeeBalanceState(attendee.id))?.remainingBalance,
      ).toBe(1500);
    });

    test("records even a one-penny owed balance in the ledger", async () => {
      // The `remainingBalance > 0` gate must fire for the smallest non-zero
      // balance (a £0.01 listing): any positive value posts the owed leg.
      const attendee = await bookDirect(1);
      expect(
        (await getAttendeeBalanceState(attendee.id))?.remainingBalance,
      ).toBe(1);
    });

    test("scales the owed balance by the booked quantity", async () => {
      const attendee = await bookDirect(1000, 3);
      expect(attendee.remaining_balance).toBe(3000);
    });

    test("returns sold_out when capacity is exhausted without a provider", async () => {
      // No provider configured: the provider-less path still preflights capacity
      // via createAttendeeAtomic, which returns capacity_exceeded when sold out.
      const listing = await createTestListing({
        maxAttendees: 1,
        unitPrice: 1000,
      });
      await createTestAttendeeDirect(listing.id, "First", "f@test.com");
      const result = await processBooking(listing, contact, 1, null, BASE_URL);
      expect(result).toEqual({ type: "sold_out" });
    });
  });

  describe("paid checkout through a provider", () => {
    test("returns the provider's checkout URL with a single priced item", async () => {
      await setupStripe();
      const listing = await createTestListing({
        maxAttendees: 10,
        unitPrice: 1500,
      });
      const { checkout, getCaptured } = stubCheckout("sess_test");
      try {
        const result = await processBooking(
          listing,
          contact,
          2,
          null,
          BASE_URL,
        );
        expect(result).toEqual({
          checkoutUrl: STUB_CHECKOUT_URL,
          type: "checkout",
        });
      } finally {
        checkout.restore();
      }
      const intent = getCaptured();
      expect(intent?.date).toBe(null);
      expect(intent?.items).toEqual([
        {
          listingId: listing.id,
          name: listing.name,
          quantity: 2,
          slug: listing.slug,
          unitPrice: 1500,
        },
      ]);
    });

    test("returns sold_out and skips the provider when capacity is exhausted", async () => {
      await setupStripe();
      const listing = await createTestListing({
        maxAttendees: 1,
        unitPrice: 1500,
      });
      await createTestAttendeeDirect(listing.id, "First", "f@test.com");
      const { calls, checkout } = stubCheckout("sess_test");
      try {
        const result = await processBooking(
          listing,
          contact,
          1,
          null,
          BASE_URL,
        );
        expect(result).toEqual({ type: "sold_out" });
      } finally {
        checkout.restore();
      }
      expect(calls()).toBe(0);
    });

    test("returns checkout_failed with no error when the provider yields null", async () => {
      await setupStripe();
      const listing = await createTestListing({
        maxAttendees: 10,
        unitPrice: 1500,
      });
      await withCheckoutStub(null, async () => {
        const result = await processBooking(
          listing,
          contact,
          1,
          null,
          BASE_URL,
        );
        expect(result).toEqual({ type: "checkout_failed" });
      });
    });

    test("returns checkout_failed carrying the provider error message", async () => {
      await setupStripe();
      const listing = await createTestListing({
        maxAttendees: 10,
        unitPrice: 1500,
      });
      await withCheckoutStub({ error: "Provider rejected" }, async () => {
        const result = await processBooking(
          listing,
          contact,
          1,
          null,
          BASE_URL,
        );
        expect(result).toEqual({
          error: "Provider rejected",
          type: "checkout_failed",
        });
      });
    });

    test("threads a pay-more custom price into the checkout item unit price", async () => {
      await setupStripe();
      const listing = await createTestListing({
        canPayMore: true,
        maxAttendees: 10,
        maxPrice: 10000,
        unitPrice: 500,
      });
      const { checkout, getCaptured } = stubCheckout("sess_test");
      try {
        const result = await processBooking(
          listing,
          contact,
          1,
          null,
          BASE_URL,
          2000,
        );
        expect(result.type).toBe("checkout");
      } finally {
        checkout.restore();
      }
      expect(getCaptured()?.items[0]?.unitPrice).toBe(2000);
    });
  });

  describe("listingHasSpots", () => {
    test("is true while capacity remains and false once sold out", async () => {
      const listing = await createTestListing({
        maxAttendees: 1,
        unitPrice: 0,
      });
      expect(await listingHasSpots(listing, 1, null)).toBe(true);
      const booked = await processBooking(listing, contact, 1, null, BASE_URL);
      expect(booked.type).toBe("success");
      expect(await listingHasSpots(listing, 1, null)).toBe(false);
    });
  });
});
