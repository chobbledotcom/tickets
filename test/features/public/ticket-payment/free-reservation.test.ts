import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { createFreeReservation } from "#routes/public/ticket-payment.ts";
import { buildTicketListing } from "#shared/booking/model.ts";
import { attendeesApi } from "#shared/db/attendees/api.ts";
import { getListingWithCount } from "#shared/db/listings/records.ts";
import type { CheckoutItem } from "#shared/payments.ts";
import type { ContactInfo, Listing } from "#shared/types.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { expectNoAttendeesForListings } from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { testListingWithCount } from "#test-utils/factories.ts";

const contact: ContactInfo = {
  address: "",
  email: "buyer@example.com",
  name: "Buyer",
  phone: "",
  special_instructions: "",
};

/** One checkout line for a listing, priced at its own unit price. */
const checkoutItemFor = (
  listing: Pick<Listing, "id" | "name" | "slug" | "unit_price">,
  overrides: Partial<CheckoutItem> = {},
): CheckoutItem => ({
  listingId: listing.id,
  name: listing.name,
  quantity: 1,
  slug: listing.slug,
  unitPrice: listing.unit_price,
  ...overrides,
});

/** Book one free listing whose order also consumes modifier stock. */
const bookOneWithStock = (
  listing: ReturnType<typeof testListingWithCount>,
): ReturnType<typeof createFreeReservation> =>
  createFreeReservation({
    contact,
    date: null,
    items: [checkoutItemFor(listing, { unitPrice: 0 })],
    ledgerOrder: null,
    listings: [buildTicketListing(listing, false, undefined)],
    modifierUsages: [{ amountApplied: 0, modifierId: 1, quantity: 1 }],
  });

describeWithEnv("free reservation construction", { db: true }, () => {
  describe("missing lookups", () => {
    test("fails before writing when a paid amount is missing", async () => {
      const listing = await createTestListing({ maxAttendees: 5 });
      const withCount = await getListingWithCount(listing.id);

      await expect(
        createFreeReservation({
          contact,
          date: null,
          items: [checkoutItemFor(withCount!)],
          ledgerOrder: null,
          listings: [buildTicketListing(withCount!, false, undefined)],
          modifierUsages: [],
          paidByItem: new Map(),
        }),
      ).rejects.toThrow(
        `Paid amount for listing ${listing.id} was not loaded for checkout`,
      );
      await expectNoAttendeesForListings([listing.id]);
    });

    test("names a listing that was not loaded for the booking", async () => {
      const missingId = 424242;
      await expect(
        createFreeReservation({
          contact,
          date: null,
          items: [
            {
              listingId: missingId,
              name: "Missing",
              quantity: 1,
              slug: "missing",
              unitPrice: 100,
            },
          ],
          ledgerOrder: null,
          listings: [],
          modifierUsages: [],
        }),
      ).rejects.toThrow(`Listing ${missingId} was not loaded for checkout`);
    });
  });

  describe("defaults", () => {
    test("uses one day, no balance, and no ledger legs when only stock is consumed", async () => {
      const listing = testListingWithCount({ id: 7 });
      using create = stub(attendeesApi, "createBookingAtomic", () =>
        Promise.resolve({
          attendees: [{ id: 1, listing_id: 7, ticket_token: "ticket-token" }],
          success: true,
        } as never),
      );

      const result = await bookOneWithStock(listing);

      expect(result).toMatchObject({ success: true, token: "ticket-token" });
      expect(create.calls[0]!.args[0]).toMatchObject({
        bookings: [
          {
            date: null,
            durationDays: 1,
            listingId: 7,
            packageGroupId: 0,
            quantity: 1,
          },
        ],
        remainingBalance: 0,
      });
      expect(create.calls[0]!.args[1].legs).toEqual([]);
    });
  });

  describe("refusals", () => {
    test("says an extra sold out while the buyer was checking out", async () => {
      const listing = testListingWithCount({ id: 8 });
      using _create = stub(attendeesApi, "createBookingAtomic", () =>
        Promise.resolve("sold-out" as const),
      );

      const result = await bookOneWithStock(listing);

      expect(result).toEqual({
        error:
          "An extra you selected sold out while you were checking out. Please try again.",
        success: false,
      });
    });

    test("names the order's first listing when it will not fit", async () => {
      const first = testListingWithCount({ id: 9, name: "First choice" });
      const second = testListingWithCount({ id: 10, name: "Second choice" });
      using _create = stub(attendeesApi, "createAttendeeAtomic", () =>
        Promise.resolve({
          reason: "capacity_exceeded",
          success: false,
        } as const),
      );

      const result = await createFreeReservation({
        contact,
        date: null,
        items: [
          checkoutItemFor(first, { unitPrice: 0 }),
          checkoutItemFor(second, { unitPrice: 0 }),
        ],
        ledgerOrder: null,
        listings: [first, second].map((listing) =>
          buildTicketListing(listing, false, undefined),
        ),
        modifierUsages: [],
      });

      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error).toContain("First choice");
      expect(result.error).not.toContain("Second choice");
    });
  });
});
