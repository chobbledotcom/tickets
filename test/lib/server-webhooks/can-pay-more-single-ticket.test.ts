import { expect } from "@std/expect";
import { afterEach, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { handleRequest } from "#routes";
import { resetStripeClient, stripeApi } from "#shared/stripe.ts";
import {
  assertJson,
  createTestListing,
  describeWithEnv,
  mockWebhookRequest,
  setupStripe,
  signedMeta,
  singleItem,
} from "#test-utils";

describeWithEnv(
  "server webhooks > can_pay_more (single-ticket)",
  { db: true },
  () => {
    afterEach(() => {
      resetStripeClient();
    });

    test("single-ticket can_pay_more accepts amount above minimum price", async () => {
      await setupStripe();

      const listing = await createTestListing({
        canPayMore: true,
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
                  amount_total: 2500,
                  id: "cs_pay_more",
                  metadata: signedMeta(
                    {
                      email: "generous@example.com",
                      items: singleItem(listing.id, 1, 2500),
                      name: "Generous User",
                    },
                    2500,
                  ),
                  payment_intent: "pi_pay_more",
                  payment_status: "paid",
                },
              },
              id: "evt_pay_more",
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

        // Verify attendee was created with the actual amount paid (2500), not the minimum (1000)
        const { getAttendeesRaw } = await import("#shared/db/attendees.ts");
        const attendees = await getAttendeesRaw(listing.id);
        expect(attendees.length).toBe(1);
        expect(
          (attendees[0] as unknown as Record<string, unknown>).price_paid,
        ).toBe(2500);
      } finally {
        mockVerify.restore();
      }
    });

    test("single-ticket can_pay_more keeps and refunds amount below minimum price", async () => {
      await setupStripe();

      const listing = await createTestListing({
        canPayMore: true,
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
                  amount_total: 500,
                  id: "cs_pay_less",
                  metadata: signedMeta(
                    {
                      email: "cheap@example.com",
                      items: singleItem(listing.id, 1, 500),
                      name: "Cheap User",
                    },
                    500,
                  ),
                  payment_intent: "pi_pay_less",
                  payment_status: "paid",
                },
              },
              id: "evt_pay_less",
              type: "checkout.session.completed",
            },
            valid: true,
          }),
      );

      const mockRefund = stub(stripeApi, "refundPayment", () =>
        Promise.resolve({ id: "re_pay_less" } as unknown as Awaited<
          ReturnType<typeof stripeApi.refundPayment>
        >),
      );

      try {
        await assertJson(
          handleRequest(
            mockWebhookRequest({}, { "stripe-signature": "sig_valid" }),
          ),
          200,
          (json) => {
            expect(json.processed).toBe(false);
            // The price reason now lives in the note; the customer sees the
            // generic saved-details message.
            expect(json.error).toContain("saved your details");
          },
        );

        // Signed by us → the booking is kept as a quantity-0 placeholder and
        // refunded once, with a system note recording the reason.
        const { getAttendeesRaw } = await import("#shared/db/attendees.ts");
        const attendees = await getAttendeesRaw(listing.id);
        expect(attendees.length).toBe(1);
        expect(attendees[0]!.quantity).toBe(0);
        expect(mockRefund.calls.length).toBe(1);
        const { getNoteRows } = await import("#shared/db/system-notes.ts");
        expect((await getNoteRows([attendees[0]!.id])).length).toBe(1);
        const { isSessionProcessed } = await import(
          "#shared/db/processed-payments.ts"
        );
        const record = await isSessionProcessed("cs_pay_less");
        expect(record?.attendee_id).toBeNull();
        expect(record?.failure_data).not.toBe("");
      } finally {
        mockVerify.restore();
        mockRefund.restore();
      }
    });

    test("single-ticket can_pay_more keeps and refunds amount above maximum price", async () => {
      await setupStripe();

      const listing = await createTestListing({
        canPayMore: true,
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
                  amount_total: 20000,
                  id: "cs_pay_too_much",
                  metadata: signedMeta(
                    {
                      email: "overpay@example.com",
                      items: singleItem(listing.id, 1, 20000),
                      name: "Overpay User",
                    },
                    20000,
                  ),
                  payment_intent: "pi_pay_too_much",
                  payment_status: "paid",
                },
              },
              id: "evt_pay_too_much",
              type: "checkout.session.completed",
            },
            valid: true,
          }),
      );

      const mockRefund = stub(stripeApi, "refundPayment", () =>
        Promise.resolve({ id: "re_pay_too_much" } as unknown as Awaited<
          ReturnType<typeof stripeApi.refundPayment>
        >),
      );

      try {
        await assertJson(
          handleRequest(
            mockWebhookRequest({}, { "stripe-signature": "sig_valid" }),
          ),
          200,
          (json) => {
            expect(json.processed).toBe(false);
            // The price reason now lives in the note; the customer sees the
            // generic saved-details message.
            expect(json.error).toContain("saved your details");
          },
        );

        // Signed by us → the booking is kept as a quantity-0 placeholder and
        // refunded once, with a system note recording the reason.
        const { getAttendeesRaw } = await import("#shared/db/attendees.ts");
        const attendees = await getAttendeesRaw(listing.id);
        expect(attendees.length).toBe(1);
        expect(attendees[0]!.quantity).toBe(0);
        expect(mockRefund.calls.length).toBe(1);
        const { getNoteRows } = await import("#shared/db/system-notes.ts");
        expect((await getNoteRows([attendees[0]!.id])).length).toBe(1);
        const { isSessionProcessed } = await import(
          "#shared/db/processed-payments.ts"
        );
        const record = await isSessionProcessed("cs_pay_too_much");
        expect(record?.attendee_id).toBeNull();
        expect(record?.failure_data).not.toBe("");
      } finally {
        mockVerify.restore();
        mockRefund.restore();
      }
    });
  },
);
