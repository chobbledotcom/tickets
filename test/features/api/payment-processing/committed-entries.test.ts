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

/** The one checked line for a listing a test just made. The listing is always
 *  there; saying so here means a missing one fails at the fixture rather than
 *  somewhere inside the code under test. */
const checkedLine = async (listingId: number): Promise<ValidatedItem[]> => {
  const listing = await getListingWithCount(listingId);
  if (listing === null) throw new Error(`Listing ${listingId} was not created`);
  return [{ listing }] as ValidatedItem[];
};

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
      const entries = await committedEntries(
        attendee.id,
        "tok_committed",
        session(),
        intent(),
        await checkedLine(listing.id),
      );

      expect(entries).toHaveLength(1);
      expect(entries[0]?.listing.id).toBe(listing.id);
      // The whole rebuilt booking, not a few fields: every value here is one
      // the booking is remade from, so a wrong one would travel on unnoticed.
      expect(entries[0]?.attendee).toEqual({
        address: "1 Test Street",
        attachment_downloads: 0,
        checked_in: false,
        created: entries[0]?.attendee.created,
        date: null,
        email: "buyer@example.com",
        end_date: null,
        id: attendee.id,
        kind: attendee.kind,
        lat: "",
        listing_id: listing.id,
        lng: "",
        name: "Signed Buyer",
        package_group_id: 0,
        payment_id: "pi_committed",
        phone: "07700900000",
        pii_blob: "",
        price_paid: "2000",
        quantity: 2,
        refunded: false,
        remaining_balance: 2000,
        special_instructions: "Ring the bell",
        split_logistics_agents: false,
        status_id: attendee.status_id,
        ticket_token: "tok_committed",
        ticket_token_index: entries[0]?.attendee.ticket_token_index,
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
      const entries = await committedEntries(
        attendee.id,
        "tok_contact",
        session(),
        intent(),
        await checkedLine(listing.id),
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
      const entries = await committedEntries(
        attendee.id,
        "tok_payment",
        session(),
        intent(),
        await checkedLine(listing.id),
      );

      expect(entries[0]?.attendee.payment_id).toBe("pi_committed");
    });

    test("reads nothing back for a booking that was never written", async () => {
      const listing = await createTestListing({
        maxAttendees: 50,
        name: "Absent Listing",
        unitPrice: 1000,
      });
      expect(
        await committedEntries(
          999999,
          "tok_none",
          session(),
          intent(),
          await checkedLine(listing.id),
        ),
      ).toEqual([]);
    });
  },
);
