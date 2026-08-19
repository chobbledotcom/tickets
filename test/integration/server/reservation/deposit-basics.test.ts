import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { pricePaidFromLedger } from "#db/attendees/select.ts";
import { getDb } from "#db/client.ts";
import { settings } from "#db/settings.ts";
import { handleRequest } from "#routes";
import { bookPaidReservation } from "#test/integration/server/_shared-setup.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { mockRequest } from "#test-utils/mocks.ts";
import {
  setPublicReservation,
  stubPaidSession,
} from "#test-utils/reservation/helpers.ts";
import { setupStripe } from "#test-utils/settings.ts";
import { stubRefundPayment } from "#test-utils/webhooks/stripe.ts";

describeWithEnv(
  "server (reservation deposit at checkout)",
  { db: true },
  () => {
    test("books a reserved attendee owing the balance after the deposit", async () => {
      await setupStripe();
      await settings.update.bookingFee("10");
      const statusId = await setPublicReservation("10%");
      const listing = await createTestListing({
        maxAttendees: 10,
        thankYouUrl: "https://example.com",
        unitPrice: 1000,
      });
      // Full £10.00, deposit 10% = £1.00, fee 10% of the full £10.00 = £1.00.
      const attendee = await bookPaidReservation(
        "cs_dep",
        {
          _origin: "localhost",
          email: "reserver@example.com",
          items: JSON.stringify([{ e: listing.id, p: 1000, q: 1 }]),
          name: "Reserver",
          reservation_amount: "10%",
        },
        200,
      );
      // price_paid projects the gross sale leg (£10), not the £1.00 deposit —
      // the accepted gross-sale divergence (concern 5 restores deposit
      // accuracy). The £9.00 still owed stays correct.
      expect(attendee.pricePaid).toBe(1000);
      expect(attendee.remainingBalance).toBe(900);
      // The booking starts in the public-default reservation status.
      expect(attendee.statusId).toBe(statusId);
    });

    test("distributes reservation deposits across multiple listings", async () => {
      await setupStripe();
      await settings.update.bookingFee("0");
      await setPublicReservation("10%");
      const general = await createTestListing({
        maxAttendees: 10,
        name: "General admission",
        thankYouUrl: "https://example.com",
        unitPrice: 1000,
      });
      const vip = await createTestListing({
        maxAttendees: 10,
        name: "VIP admission",
        thankYouUrl: "https://example.com",
        unitPrice: 2000,
      });
      const attendee = await bookPaidReservation(
        "cs_multi_dep",
        {
          _origin: "localhost",
          email: "reserver@example.com",
          items: JSON.stringify([
            { e: general.id, p: 1000, q: 1 },
            { e: vip.id, p: 2000, q: 1 },
          ]),
          name: "Reserver",
          reservation_amount: "10%",
        },
        300,
      );
      expect(attendee.remainingBalance).toBe(2700);
      // Per-row price_paid projects each listing's gross sale leg (£10 / £20),
      // not the distributed £1 / £2 deposit — the gross-sale divergence. The
      // £27 owed stays accurate; concern 5 restores the deposit distribution.
      const paidRows = await getDb().execute({
        args: [attendee.id],
        sql: `SELECT listing_id, ${pricePaidFromLedger(
          "listing_attendees.attendee_id",
          "listing_attendees.listing_id",
          "listing_attendees.ledger_event_group",
          "listing_attendees.id",
        )} FROM listing_attendees WHERE attendee_id = ?`,
      });
      const paidByListing = new Map(
        paidRows.rows.map((row) => [
          Number(row.listing_id),
          Number(row.price_paid),
        ]),
      );
      expect(paidByListing.get(general.id)).toBe(1000);
      expect(paidByListing.get(vip.id)).toBe(2000);
    });

    test("recomputes flat split deposits exactly when storing the remaining balance", async () => {
      await setupStripe();
      await settings.update.bookingFee("0");
      await setPublicReservation("10");
      const listing = await createTestListing({
        maxAttendees: 10,
        thankYouUrl: "https://example.com",
        unitPrice: 1000,
      });
      const attendee = await bookPaidReservation(
        "cs_flat_split",
        {
          _origin: "localhost",
          email: "reserver@example.com",
          items: JSON.stringify([{ e: listing.id, p: 3000, q: 3 }]),
          name: "Reserver",
          reservation_amount: "10",
        },
        1000,
      );
      // Gross sale leg of the 3 × £10 booking (£30); the £20 owed stays
      // accurate. The £10 deposit lives in the payment leg (concern 5).
      expect(attendee.pricePaid).toBe(3000);
      expect(attendee.remainingBalance).toBe(2000);
    });

    test("keeps and refunds when the charged total does not match deposit plus fee", async () => {
      await setupStripe();
      await settings.update.bookingFee("10");
      await setPublicReservation("10%");
      const listing = await createTestListing({
        maxAttendees: 10,
        thankYouUrl: "https://example.com",
        unitPrice: 1000,
      });
      const refund = stubRefundPayment("re_bad", 150);
      // Expected total is 200 (deposit 100 + fee 100); charge a wrong 150.
      const session = stubPaidSession(
        "cs_bad",
        {
          _origin: "localhost",
          email: "reserver@example.com",
          items: JSON.stringify([{ e: listing.id, p: 1000, q: 1 }]),
          name: "Reserver",
          reservation_amount: "10%",
        },
        150,
      );
      try {
        const response = await handleRequest(
          mockRequest("/payment/success?session_id=cs_bad"),
        );
        // Signed by us → the reservation is kept and refunded (HTTP 200), not
        // dropped.
        expect(response.status).toBe(200);
        const { rows } = await getDb().execute(
          "SELECT COUNT(*) AS c FROM attendees",
        );
        expect(Number(rows[0]!.c)).toBe(1);
      } finally {
        session.restore();
        refund.restore();
      }
    });
  },
);
