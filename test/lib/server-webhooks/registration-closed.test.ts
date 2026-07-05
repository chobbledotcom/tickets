import { expect } from "@std/expect";
import { afterEach, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { handleRequest } from "#routes";
import { resetStripeClient, stripeApi } from "#shared/stripe.ts";
import {
  assertJson,
  createTestListing,
  describeWithEnv,
  expectHtmlResponse,
  mockRequest,
  mockWebhookRequest,
  setupStripe,
  signedMeta,
  signMeta,
  singleItem,
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

      const { stripePaymentProvider } = await import(
        "#shared/stripe-provider.ts"
      );
      const mockVerify = stub(
        stripePaymentProvider,
        "verifyWebhookSignature",
        () =>
          Promise.resolve({
            listing: {
              data: {
                object: {
                  amount_total: 1000,
                  id: "cs_closed_wh",
                  metadata: signedMeta(
                    {
                      email: "jane@example.com",
                      items: singleItem(listing.id, 1, 1000),
                      name: "Jane",
                    },
                    1000,
                  ),
                  payment_intent: "pi_closed_wh",
                  payment_status: "paid",
                },
              },
              id: "evt_closed",
              type: "checkout.session.completed",
            },
            valid: true,
          }),
      );

      const mockRefund = stub(stripeApi, "refundPayment", () =>
        Promise.resolve({ id: "re_closed" } as unknown as Awaited<
          ReturnType<typeof stripeApi.refundPayment>
        >),
      );

      try {
        await assertJson(
          handleRequest(
            mockWebhookRequest({}, { "stripe-signature": "sig_closed" }),
          ),
          200,
          (json) => {
            expect(json.error).toContain("registration closed");
          },
        );
      } finally {
        mockVerify.restore();
        mockRefund.restore();
      }
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

      const { stripePaymentProvider } = await import(
        "#shared/stripe-provider.ts"
      );
      const mockVerify = stub(
        stripePaymentProvider,
        "verifyWebhookSignature",
        () =>
          Promise.resolve({
            listing: {
              data: {
                object: {
                  amount_total: 1500,
                  id: "cs_multi_closed",
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
                  payment_intent: "pi_multi_closed",
                  payment_status: "paid",
                },
              },
              id: "evt_multi_closed",
              type: "checkout.session.completed",
            },
            valid: true,
          }),
      );

      const mockRefund = stub(stripeApi, "refundPayment", () =>
        Promise.resolve({ id: "re_multi_closed" } as unknown as Awaited<
          ReturnType<typeof stripeApi.refundPayment>
        >),
      );

      try {
        await assertJson(
          handleRequest(
            mockWebhookRequest({}, { "stripe-signature": "sig_multi_closed" }),
          ),
          200,
          (json) => {
            expect(json.error).toContain("registration for");
            expect(json.error).toContain("closed");
          },
        );

        // Verify listing1 attendee was rolled back
        const { getAttendeesRaw } = await import("#shared/db/attendees.ts");
        const attendees1 = await getAttendeesRaw(listing1.id);
        expect(attendees1.length).toBe(0);
      } finally {
        mockVerify.restore();
        mockRefund.restore();
      }
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

      const { stripePaymentProvider } = await import(
        "#shared/stripe-provider.ts"
      );
      const mockVerify = stub(
        stripePaymentProvider,
        "verifyWebhookSignature",
        () =>
          Promise.resolve({
            listing: {
              data: {
                object: {
                  amount_total: 800,
                  id: "cs_multi_daily",
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
                  payment_intent: "pi_multi_daily",
                  payment_status: "paid",
                },
              },
              id: "evt_multi_daily",
              type: "checkout.session.completed",
            },
            valid: true,
          }),
      );

      try {
        await assertJson(
          handleRequest(
            mockWebhookRequest({}, { "stripe-signature": "sig_valid" }),
          ),
          200,
          (json) => {
            expect(json.processed).toBe(true);
          },
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
      } finally {
        mockVerify.restore();
      }
    });
  },
);
