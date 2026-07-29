import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { committedEntries } from "#routes/api/payment-processing/committed-entries.ts";
import type { ValidatedItem } from "#routes/api/payment-processing/package-pricing.ts";
import type { BookingIntent } from "#shared/booking-intent.ts";
import { getListingWithCount } from "#shared/db/listings/records.ts";
import type { ValidatedPaymentSession } from "#shared/payments.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestAttendee } from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { webhookMeta } from "#test-utils/factories.ts";

/** The buyer's details, exactly as the checkout signed them. */
const intent = (): BookingIntent => ({
  address: "1 Test Street",
  date: null,
  email: "buyer@example.com",
  items: [{ e: 1, p: 1000, q: 1 }],
  modifiers: [],
  name: "Signed Buyer",
  phone: "07700900000",
  special_instructions: "Ring the bell",
});

/** The checkout the money was taken through. Only the payment it was taken
 *  under is read here, but it is built whole so nothing is pretended. */
const session = (): ValidatedPaymentSession => ({
  amountTotal: 1000,
  id: "cs_committed",
  metadata: webhookMeta({ name: "Signed Buyer" }),
  paymentReference: "pi_committed",
  paymentStatus: "paid",
});

describeWithEnv(
  "rebuilding what was booked from the rows that were written",
  { db: true },
  () => {
    test("reads the booking back and pairs it with its listing", async () => {
      const listing = await createTestListing({
        maxAttendees: 50,
        maxQuantity: 5,
        name: "Committed Listing",
        unitPrice: 1000,
      });
      const attendee = await createTestAttendee(
        listing.id,
        listing.slug,
        "Booked Buyer",
        "booked@example.com",
        2,
      );
      const loaded = await getListingWithCount(listing.id);

      const entries = await committedEntries(
        attendee.id,
        "tok_committed",
        session(),
        intent(),
        [{ listing: loaded }] as ValidatedItem[],
      );

      expect(entries).toHaveLength(1);
      expect(entries[0]?.listing.id).toBe(listing.id);
      expect(entries[0]?.attendee).toMatchObject({
        id: attendee.id,
        listing_id: listing.id,
        quantity: 2,
        ticket_token: "tok_committed",
      });
    });

    test("carries the buyer's details from the signed checkout, not the row", async () => {
      // The row's own details are encrypted; the checkout is the one place
      // that still holds them in the clear at this point.
      const listing = await createTestListing({
        maxAttendees: 50,
        name: "Contact Listing",
        unitPrice: 1000,
      });
      const attendee = await createTestAttendee(
        listing.id,
        listing.slug,
        "Row Name",
        "row@example.com",
      );
      const loaded = await getListingWithCount(listing.id);

      const entries = await committedEntries(
        attendee.id,
        "tok_contact",
        session(),
        intent(),
        [{ listing: loaded }] as ValidatedItem[],
      );

      expect(entries[0]?.attendee).toMatchObject({
        address: "1 Test Street",
        email: "buyer@example.com",
        name: "Signed Buyer",
        phone: "07700900000",
        special_instructions: "Ring the bell",
      });
    });

    test("keeps the payment the money was taken under", async () => {
      const listing = await createTestListing({
        maxAttendees: 50,
        name: "Payment Listing",
        unitPrice: 1000,
      });
      const attendee = await createTestAttendee(
        listing.id,
        listing.slug,
        "Paid Buyer",
        "paid@example.com",
      );
      const loaded = await getListingWithCount(listing.id);

      const entries = await committedEntries(
        attendee.id,
        "tok_payment",
        session(),
        intent(),
        [{ listing: loaded }] as ValidatedItem[],
      );

      expect(entries[0]?.attendee.payment_id).toBe("pi_committed");
    });

    test("reads nothing back for a booking that was never written", async () => {
      const listing = await createTestListing({
        maxAttendees: 50,
        name: "Absent Listing",
        unitPrice: 1000,
      });
      const loaded = await getListingWithCount(listing.id);

      expect(
        await committedEntries(999999, "tok_none", session(), intent(), [
          { listing: loaded },
        ] as ValidatedItem[]),
      ).toEqual([]);
    });
  },
);
