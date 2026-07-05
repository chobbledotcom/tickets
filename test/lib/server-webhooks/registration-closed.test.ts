import { expect } from "@std/expect";
import { afterEach, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { handleRequest } from "#routes";
import { resetStripeClient, stripeApi } from "#shared/stripe.ts";
import {
  checkoutSessionEvent,
  createTestListing,
  describeWithEnv,
  expectHtmlResponse,
  expectWebhookProcessed,
  mockRequest,
  postWebhookAndAssert,
  setupStripe,
  signedMeta,
  signMeta,
  singleItem,
  stubWebhookVerify,
  webhookMeta,
} from "#test-utils";

describeWithEnv(
  "server webhooks > registration closed (closes_at)",
  { db: true },
  () => {
    afterEach(() => {
      resetStripeClient();
    });

    test("refunds and shows error when listing registration has closed (single ticket)", async () => {
      await setupStripe();

      const pastDate = new Date(Date.now() - 60000).toISOString().slice(0, 16);
      const listing = await createTestListing({
        closesAt: pastDate,
        maxAttendees: 50,
        unitPrice: 1000,
      });

      const mockRetrieve = stub(stripeApi, "retrieveCheckoutSession", () =>
        Promise.resolve({
          amount_total: 1000,
          id: "cs_closed",
          metadata: signMeta(
            webhookMeta({
              email: "john@example.com",
              items: singleItem(listing.id, 1, 1000),
              name: "John",
            }),
            1000,
          ),
          payment_intent: "pi_closed",
          payment_status: "paid",
        } as unknown as Awaited<
          ReturnType<typeof stripeApi.retrieveCheckoutSession>
        >),
      );

      const mockRefund = stub(stripeApi, "refundPayment", () =>
        Promise.resolve({ id: "re_test" } as unknown as Awaited<
          ReturnType<typeof stripeApi.refundPayment>
        >),
      );

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

      const pastDate = new Date(Date.now() - 60000).toISOString().slice(0, 16);
      const listing = await createTestListing({
        closesAt: pastDate,
        maxAttendees: 50,
        unitPrice: 1000,
      });

      const mockVerify = await stubWebhookVerify(
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
      );

      const mockRefund = stub(stripeApi, "refundPayment", () =>
        Promise.resolve({ id: "re_closed" } as unknown as Awaited<
          ReturnType<typeof stripeApi.refundPayment>
        >),
      );

      await postWebhookAndAssert(
        () => {
          mockVerify.restore();
          mockRefund.restore();
        },
        200,
        (json) => {
          expect(json.error).toContain("registration closed");
        },
        "sig_closed",
      );
    });

    test("webhook refunds when multi-ticket listing registration has closed", async () => {
      await setupStripe();

      const pastDate = new Date(Date.now() - 60000).toISOString().slice(0, 16);
      const listing1 = await createTestListing({
        maxAttendees: 50,
        unitPrice: 1000,
      });
      // listing2 is closed
      const listing2 = await createTestListing({
        closesAt: pastDate,
        maxAttendees: 50,
        unitPrice: 500,
      });

      const mockVerify = await stubWebhookVerify(
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
      );

      const mockRefund = stub(stripeApi, "refundPayment", () =>
        Promise.resolve({ id: "re_multi_closed" } as unknown as Awaited<
          ReturnType<typeof stripeApi.refundPayment>
        >),
      );

      await postWebhookAndAssert(
        () => {
          mockVerify.restore();
          mockRefund.restore();
        },
        200,
        (json) => {
          expect(json.error).toContain("registration for");
          expect(json.error).toContain("closed");
        },
        "sig_multi_closed",
      );

      // Verify listing1 attendee was rolled back
      const { getAttendeesRaw } = await import("#shared/db/attendees.ts");
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
      const { getAttendeesRaw } = await import("#shared/db/attendees.ts");
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
