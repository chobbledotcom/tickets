/**
 * The quantity-refusal contract every buying surface reads, in one table.
 * Each surface sees a quantity below the listing's minimum, one above its
 * maximum, and one the listing no longer has places to serve. The copy lives
 * once in `bookingError` and the payment failure group, so a surface that
 * misses the rule fails here instead of drifting.
 *
 * The two projection surfaces — discovery's sold-out state and the
 * `/listings` date filter — do not take a submitted quantity. Their
 * fewer-places cells are the sold-out flips pinned in
 * `test/features/public/discovery.test.ts` and
 * `test/features/public/listing-date-availability.test.ts`.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getAttendeesRaw } from "#db/attendees/queries.ts";
import { setGroupPackageMembers } from "#db/groups.ts";
import { settings } from "#db/settings.ts";
import { withMessageGroups } from "#i18n";
import { apiBookPackage } from "#test/features/api/packages/helpers.ts";
import {
  bookingIntent,
  paymentSession,
} from "#test/features/api/payment-processing/index/helpers.ts";
import { validateAllItems } from "#test/features/api/payment-processing/items/helpers.ts";
import { scanWithStripe } from "#test/features/public/qr-book/helpers.ts";
import {
  bookListing,
  createAndBook,
  describePublicApi,
} from "#test-utils/api/helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { setupStripe } from "#test-utils/settings.ts";
import { stubRefundPayment } from "#test-utils/webhooks/stripe.ts";

describePublicApi(() => {
  test("the booking API refuses min-1, max+1, and fewer places than the minimum", async () => {
    // Below the minimum, above the maximum: the two stored per-listing facts.
    const { listing, response, body } = await createAndBook(
      { maxAttendees: 10, maxQuantity: 5, minQuantity: 3, unitPrice: 0 },
      { quantity: 2 },
    );
    expect(response.status).toBe(400);
    expect(body.error).toBe("Quantity must be at least 3.");
    expect((await getAttendeesRaw(listing.id)).length).toBe(0);

    const above = await createAndBook(
      { maxAttendees: 10, maxQuantity: 5, minQuantity: 3, unitPrice: 0 },
      { quantity: 6 },
    );
    expect(above.response.status).toBe(400);
    expect(above.body.error).toBe("Quantity must be at most 5.");
    expect((await getAttendeesRaw(above.listing.id)).length).toBe(0);

    // Fewer places left than the minimum: the capacity check refuses.
    const scarce = await createTestListing({
      maxAttendees: 4,
      maxQuantity: 5,
      minQuantity: 3,
      name: "Scarce Places",
      unitPrice: 0,
    });
    const first = await bookListing(scarce.slug, { quantity: 3 });
    expect(first.response.status).toBe(200);
    const gone = await bookListing(scarce.slug, { quantity: 3 });
    expect(gone.response.status).toBe(409);
    expect(gone.body.error).toBe("Sorry, not enough spots available");
    // One booking row carries the three places; the refused order adds none.
    expect((await getAttendeesRaw(scarce.id)).length).toBe(1);
  });

  test("the package API refuses min-1, max+1, and fewer places than the minimum", async () => {
    const group = await createTestGroup({
      isPackage: true,
      name: "Refusal Kit",
      slug: "refusal-kit",
    });
    const member = await createTestListing({
      groupId: group.id,
      maxAttendees: 10,
      maxQuantity: 10,
      minQuantity: 3,
      name: "Refusal Kit Member",
      unitPrice: 0,
    });
    await setGroupPackageMembers(group.id, [
      { listingId: member.id, price: null },
    ]);

    // Below the minimum: two bundles put 2 units on a member that sells at
    // least 3 per purchase, so the fold refuses before any booking lands.
    const below = await apiBookPackage(group.slug, { quantity: 2 });
    expect(below.response.status).toBe(400);
    expect(below.body.error).toContain("sells at least 3");
    expect((await getAttendeesRaw(member.id)).length).toBe(0);

    // At the fold's cap: five of ten spots go, and the booking lands as one
    // member line carrying the five units.
    const atCap = await apiBookPackage(group.slug, { quantity: 5 });
    expect(atCap.response.status).toBe(200);
    const capRows = await getAttendeesRaw(member.id);
    expect(capRows.length).toBe(1);
    expect(capRows[0]!.quantity).toBe(5);

    // Fewer places than the request: the live limit folds the remaining
    // capacity in, so a count the same buyer could have booked before now
    // reads a refusal naming the smaller cap.
    const above = await apiBookPackage(group.slug, { quantity: 6 });
    expect(above.response.status).toBe(400);
    expect(above.body.error).toBe("Quantity must be at most 5.");
    expect((await getAttendeesRaw(member.id)).length).toBe(1);
  });
});

describeWithEnv("Quantity refusal table", { db: true }, () => {
  test("the QR checkout skip refuses min-1 and max+1, and leaves capacity to the webhook", async () => {
    // The drain booking below goes through the booking API, so the site
    // needs it on; the QR scan itself reads no API setting.
    await settings.update.showPublicApi(true);
    const makeListing = (name: string, maxAttendees: number) =>
      createTestListing({
        fields: "",
        maxAttendees,
        maxQuantity: 5,
        minQuantity: 3,
        name,
        unitPrice: 500,
      });

    // Below the minimum and above the maximum: the token carries a quantity
    // the listing no longer sells, so the scan renders the booking form and
    // starts no checkout.
    for (const quantity of [2, 6]) {
      await scanWithStripe(
        await makeListing(`Code Door ${quantity}`, 10),
        async ({ response, stripe }) => {
          expect(response.status).toBe(200);
          expect(stripe.calls()).toBe(0);
        },
        { name: "Ada", quantity, value: 500 },
      );
    }

    // Fewer places left than the minimum: the drain booking leaves two, and
    // the skip's own guards pass (the token quantity sits between the stored
    // minimum and maximum), so the checkout starts. What the webhook then
    // does with a quantity the remaining cannot serve is the next test's
    // subject; this one pins only that the skip hands the buyer to checkout.
    const tight = await makeListing("Code Door Tight", 4);
    await bookListing(tight.slug, { quantity: 2 });
    expect((await getAttendeesRaw(tight.id)).length).toBe(2);
    await scanWithStripe(
      tight,
      async ({ response, stripe }) => {
        expect(stripe.calls()).toBe(1);
        expect(response.status).toBe(302);
      },
      { name: "Ada", quantity: 3, value: 500 },
    );
  });

  test("the payment webhook refuses min-1 and max+1, and leaves capacity to booking creation", async () => {
    await setupStripe();
    const listing = await createTestListing({
      maxAttendees: 10,
      name: "Last Stop",
      unitPrice: 500,
    });
    const { execute } = await import("#db/client.ts");
    await execute(
      "UPDATE listings SET min_quantity = 3, max_quantity = 2 WHERE id = ?",
      [listing.id],
    );
    const belowIntent = bookingIntent([{ e: listing.id, p: 500, q: 1 }]);
    const aboveIntent = bookingIntent([{ e: listing.id, p: 500, q: 3 }]);

    // Below the minimum: the payment refunds instead of booking.
    {
      using belowRefund = stubRefundPayment("re_table_below", 500);
      const below = await withMessageGroups(["payment"], () =>
        validateAllItems(
          paymentSession("cs_table_below", 500, belowIntent),
          belowIntent,
        ),
      );
      expect(below).toEqual({
        detail: undefined,
        error: "Sorry, Last Stop sells at least 3 tickets per booking.",
        refunded: true,
        status: 410,
        success: false,
      });
      expect(belowRefund.calls.length).toBe(1);
    }

    // Above the maximum: the same staleness in the other direction.
    {
      using aboveRefund = stubRefundPayment("re_table_above", 1500);
      const above = await withMessageGroups(["payment"], () =>
        validateAllItems(
          paymentSession("cs_table_above", 1500, aboveIntent),
          aboveIntent,
        ),
      );
      expect(above).toEqual({
        detail: undefined,
        error: "Sorry, Last Stop sells at most 2 tickets per booking.",
        refunded: true,
        status: 410,
        success: false,
      });
      expect(aboveRefund.calls.length).toBe(1);
    }
  });
});
