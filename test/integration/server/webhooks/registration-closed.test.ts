// jscpd:ignore-start
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { expectHtmlResponse } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { signedMeta, singleItem } from "#test-utils/factories.ts";
import { mockRequest } from "#test-utils/mocks.ts";
import { setupStripe } from "#test-utils/settings.ts";
import {
  checkoutSessionEvent,
  expectWebhookKeptAndRefunded,
  expectWebhookProcessed,
  stubRefundPayment,
  stubRetrieveCheckoutSession,
} from "#test-utils/webhooks.ts";

// jscpd:ignore-end

/** A listing whose registration closed a minute ago — every closes_at test
 *  below books against one of these, varying only the price. */
const createClosedListing = (unitPrice: number) => {
  const pastDate = new Date(Date.now() - 60000).toISOString().slice(0, 16);
  return createTestListing({ closesAt: pastDate, maxAttendees: 50, unitPrice });
};

describeWithEnv(
  "server webhooks > registration closed (closes_at)",
  { db: true },
  () => {
    test("refunds and shows error when listing registration has closed (single ticket)", async () => {
      await setupStripe();

      const listing = await createClosedListing(1000);

      const mockRetrieve = stubRetrieveCheckoutSession({
        amountTotal: 1000,
        email: "john@example.com",
        items: singleItem(listing.id, 1, 1000),
        name: "John",
        paymentIntent: "pi_closed",
        sessionId: "cs_closed",
      });

      const mockRefund = stubRefundPayment();

      try {
        const response = await handleRequest(
          mockRequest("/payment/success?session_id=cs_closed"),
        );
        await expectHtmlResponse(
          response,
          410,
          "registration closed",
          "refunded",
        );
      } finally {
        mockRetrieve.restore();
        mockRefund.restore();
      }
    });

    test("webhook refunds when listing registration has closed (single ticket)", async () => {
      await setupStripe();

      const listing = await createClosedListing(1000);

      await expectWebhookKeptAndRefunded(
        checkoutSessionEvent({
          amountTotal: 1000,
          eventId: "evt_closed",
          metadata: signedMeta(
            {
              email: "jane@example.com",
              items: singleItem(listing.id, 1, 1000),
              name: "Jane",
            },
            1000,
          ),
          paymentIntent: "pi_closed_wh",
          sessionId: "cs_closed_wh",
        }),
        "re_closed",
        "registration closed",
        "sig_closed",
      );
    });

    test("webhook refunds when multi-ticket listing registration has closed", async () => {
      await setupStripe();

      const listing1 = await createTestListing({
        maxAttendees: 50,
        unitPrice: 1000,
      });
      // listing2 is closed
      const listing2 = await createClosedListing(500);

      await expectWebhookKeptAndRefunded(
        checkoutSessionEvent({
          amountTotal: 1500,
          eventId: "evt_multi_closed",
          metadata: signedMeta(
            {
              email: "jane@example.com",
              items: JSON.stringify([
                { e: listing1.id, p: 1000, q: 1 },
                { e: listing2.id, p: 500, q: 1 },
              ]),
              name: "Jane",
            },
            1500,
          ),
          paymentIntent: "pi_multi_closed",
          sessionId: "cs_multi_closed",
        }),
        "re_multi_closed",
        ["registration for", "closed"],
        "sig_multi_closed",
      );

      // Verify listing1 attendee was rolled back
      const { getAttendeesRaw } = await import(
        "#shared/db/attendees/queries.ts"
      );
      const attendees1 = await getAttendeesRaw(listing1.id);
      expect(attendees1.length).toBe(0);
    });

    test("multi-ticket webhook passes date to daily listings only", async () => {
      await setupStripe();

      const listing1 = await createTestListing({
        bookableDays: [
          "Monday",
          "Tuesday",
          "Wednesday",
          "Thursday",
          "Friday",
          "Saturday",
          "Sunday",
        ],
        listingType: "daily",
        maxAttendees: 50,
        maximumDaysAfter: 14,
        minimumDaysBefore: 0,
        name: "Multi WH Daily",
        unitPrice: 500,
      });
      const listing2 = await createTestListing({
        maxAttendees: 50,
        name: "Multi WH Standard",
        unitPrice: 300,
      });

      await expectWebhookProcessed(
        checkoutSessionEvent({
          amountTotal: 800,
          eventId: "evt_multi_daily",
          metadata: signedMeta(
            {
              date: "2026-02-10",
              email: "multidaily@example.com",
              items: JSON.stringify([
                { e: listing1.id, p: 500, q: 1 },
                { e: listing2.id, p: 300, q: 1 },
              ]),
              name: "Multi Daily Buyer",
            },
            800,
          ),
          paymentIntent: "pi_multi_daily",
          sessionId: "cs_multi_daily",
        }),
      );

      // Verify daily listing attendee has the date set
      const { getAttendeesRaw } = await import(
        "#shared/db/attendees/queries.ts"
      );
      const attendees1 = await getAttendeesRaw(listing1.id);
      expect(attendees1.length).toBe(1);
      expect(attendees1[0]?.date).toBe("2026-02-10");

      // Verify standard listing attendee has null date
      const attendees2 = await getAttendeesRaw(listing2.id);
      expect(attendees2.length).toBe(1);
      expect(attendees2[0]?.date).toBeNull();
    });
  },
);
