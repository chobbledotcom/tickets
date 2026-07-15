import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { createFreeReservation } from "#routes/public/ticket-payment.ts";
import { buildTicketListing } from "#shared/booking/model.ts";
import { getListingWithCount } from "#shared/db/listings/records.ts";
import { modifierUsedQuantities } from "#shared/db/modifier-usage.ts";
import { modifiersTable } from "#shared/db/modifiers.ts";
import type { CheckoutItem } from "#shared/payments.ts";
import type { ContactInfo, ListingWithCount } from "#shared/types.ts";
import { withRejectedBookingWrite } from "#test-utils/atomic-booking.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { expectNoAttendeesForListings } from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";

const contact: ContactInfo = {
  address: "",
  email: "free-atomic@example.com",
  name: "Free Atomic",
  phone: "",
  special_instructions: "",
};

const reservationParts = async (
  listings: { id: number }[],
): Promise<{
  items: CheckoutItem[];
  listingRows: ReturnType<typeof buildTicketListing>[];
}> => {
  const listingRows = await Promise.all(
    listings.map(async ({ id }) =>
      buildTicketListing(
        (await getListingWithCount(id)) as ListingWithCount,
        false,
        undefined,
      ),
    ),
  );
  return {
    items: listingRows.map(({ listing }) => ({
      listingId: listing.id,
      name: listing.name,
      quantity: 1,
      slug: listing.slug,
      unitPrice: listing.unit_price,
    })),
    listingRows,
  };
};

describeWithEnv("free reservation atomic failures", { db: true }, () => {
  test("rolls back an available listing when a later listing has no capacity", async () => {
    const first = await createTestListing({ maxAttendees: 5 });
    const full = await createTestListing({ maxAttendees: 0 });
    const { items, listingRows } = await reservationParts([first, full]);
    const result = await createFreeReservation({
      contact,
      date: null,
      items,
      ledgerOrder: null,
      listings: listingRows,
      modifierUsages: [],
    });

    expect(result.success).toBe(false);
    await expectNoAttendeesForListings([first.id, full.id]);
  });

  test("rolls back every listing and propagates an unexpected database error", async () => {
    const first = await createTestListing({ maxAttendees: 5 });
    const rejected = await createTestListing({ maxAttendees: 5 });
    const { items, listingRows } = await reservationParts([first, rejected]);
    const modifier = await modifiersTable.insert({
      calcKind: "fixed",
      calcValue: 100,
      direction: "charge",
      name: "Available extra",
      stock: 5,
    });

    await withRejectedBookingWrite(rejected.id, async () => {
      await expect(
        createFreeReservation({
          contact,
          date: null,
          items,
          ledgerOrder: null,
          listings: listingRows,
          modifierUsages: [
            { amountApplied: 100, modifierId: modifier.id, quantity: 1 },
          ],
        }),
      ).rejects.toThrow("unexpected booking write");
    });

    await expectNoAttendeesForListings([first.id, rejected.id]);
    expect(await modifierUsedQuantities([modifier.id])).toEqual(new Map());
  });
});
