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
  "server webhooks > can_pay_more (multi-ticket)",
  { db: true },
  () => {
    afterEach(() => {
      resetStripeClient();
    });

    test("multi-ticket can_pay_more uses per-item prices from metadata", async () => {
      await setupStripe();

      const listing1 = await createTestListing({
        canPayMore: true,
        maxAttendees: 50,
        name: "Multi Pay More 1",
        unitPrice: 500,
      });
      const listing2 = await createTestListing({
        maxAttendees: 50,
        name: "Multi Pay More 2",
        unitPrice: 1000,
      });

      // Listing1 base 500, user entered 2000; Listing2 base 1000, stays 1000
      // Total: 2000 + 1000 = 3000
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
                  amount_total: 3000,
                  id: "cs_multi_pay_more",
                  metadata: signedMeta(
                    {
                      email: "generous@example.com",
                      items: JSON.stringify([
                        { e: listing1.id, p: 2000, q: 1 },
                        { e: listing2.id, p: 1000, q: 1 },
                      ]),
                      name: "Multi Generous",
                    },
                    3000,
                  ),
                  payment_intent: "pi_multi_pay_more",
                  payment_status: "paid",
                },
              },
              id: "evt_multi_pay_more",
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

        // Verify both attendees were created with correct per-item prices
        const { getAttendeesRaw } = await import("#shared/db/attendees.ts");
        const attendees1 = await getAttendeesRaw(listing1.id);
        const attendees2 = await getAttendeesRaw(listing2.id);
        expect(attendees1.length).toBe(1);
        expect(
          (attendees1[0] as unknown as Record<string, unknown>).price_paid,
        ).toBe(2000);
        expect(attendees2.length).toBe(1);
        expect(
          (attendees2[0] as unknown as Record<string, unknown>).price_paid,
        ).toBe(1000);
      } finally {
        mockVerify.restore();
      }
    });

    test("multi-ticket keeps and refunds amount above listing price when can_pay_more is disabled", async () => {
      await setupStripe();

      const listing1 = await createTestListing({
        maxAttendees: 50,
        name: "No Pay More",
        unitPrice: 500,
      });
      const listing2 = await createTestListing({
        maxAttendees: 50,
        name: "Normal Price",
        unitPrice: 1000,
      });

      // Same metadata shape as the pay-more test, but listing1 has can_pay_more=false
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
                  amount_total: 3000,
                  id: "cs_no_pay_more",
                  metadata: signedMeta(
                    {
                      email: "over@example.com",
                      items: JSON.stringify([
                        { e: listing1.id, p: 2000, q: 1 },
                        { e: listing2.id, p: 1000, q: 1 },
                      ]),
                      name: "Over Payer",
                    },
                    3000,
                  ),
                  payment_intent: "pi_no_pay_more",
                  payment_status: "paid",
                },
              },
              id: "evt_no_pay_more",
              type: "checkout.session.completed",
            },
            valid: true,
          }),
      );

      const mockRefund = stub(stripeApi, "refundPayment", () =>
        Promise.resolve({ id: "re_no_pay_more" } as unknown as Awaited<
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

        // Signed by us → the order is kept as one quantity-0 placeholder across
        // both listings and refunded once, with a system note.
        const { getAttendeesRaw } = await import("#shared/db/attendees.ts");
        const attendees1 = await getAttendeesRaw(listing1.id);
        const attendees2 = await getAttendeesRaw(listing2.id);
        expect(attendees1.length).toBe(1);
        expect(attendees2.length).toBe(1);
        expect(attendees1[0]!.id).toBe(attendees2[0]!.id);
        expect(attendees1[0]!.quantity).toBe(0);
        expect(mockRefund.calls.length).toBe(1);
        const { getNoteRows } = await import("#shared/db/system-notes.ts");
        expect((await getNoteRows([attendees1[0]!.id])).length).toBe(1);
        const { isSessionProcessed } = await import(
          "#shared/db/processed-payments.ts"
        );
        const record = await isSessionProcessed("cs_no_pay_more");
        expect(record?.attendee_id).toBeNull();
        expect(record?.failure_data).not.toBe("");
      } finally {
        mockVerify.restore();
        mockRefund.restore();
      }
    });

    test("multi-ticket can_pay_more accepts total at max_price × quantity boundary", async () => {
      await setupStripe();

      // unitPrice=1000, maxPrice=10000 (default), quantity=2
      // maxWithFee = 10000 * 2 = 20000 (no booking fee in tests)
      // amount_total=20000 is exactly at the boundary → should be accepted
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
                  id: "cs_qty2_at_max",
                  metadata: signedMeta(
                    {
                      email: "boundary@example.com",
                      items: singleItem(listing.id, 2, 20000),
                      name: "Boundary User",
                    },
                    20000,
                  ),
                  payment_intent: "pi_qty2_at_max",
                  payment_status: "paid",
                },
              },
              id: "evt_qty2_at_max",
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

        // Verify one attendee record was created (quantity=2 is stored on the record)
        const { getAttendeesRaw } = await import("#shared/db/attendees.ts");
        const attendees = await getAttendeesRaw(listing.id);
        expect(attendees.length).toBe(1);
        expect(attendees[0]!.quantity).toBe(2);
      } finally {
        mockVerify.restore();
      }
    });

    test("multi-ticket can_pay_more keeps and refunds total above max_price × quantity", async () => {
      await setupStripe();

      // unitPrice=1000, maxPrice=10000 (default), quantity=2
      // maxWithFee = 10000 * 2 = 20000 (no booking fee in tests)
      // amount_total=20001 exceeds the boundary → should be refunded
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
                  amount_total: 20001,
                  id: "cs_qty2_over_max",
                  metadata: signedMeta(
                    {
                      email: "overpay-qty2@example.com",
                      items: singleItem(listing.id, 2, 20001),
                      name: "Overpay Qty2 User",
                    },
                    20001,
                  ),
                  payment_intent: "pi_qty2_over_max",
                  payment_status: "paid",
                },
              },
              id: "evt_qty2_over_max",
              type: "checkout.session.completed",
            },
            valid: true,
          }),
      );

      const mockRefund = stub(stripeApi, "refundPayment", () =>
        Promise.resolve({ id: "re_qty2_over_max" } as unknown as Awaited<
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
        const record = await isSessionProcessed("cs_qty2_over_max");
        expect(record?.attendee_id).toBeNull();
        expect(record?.failure_data).not.toBe("");
      } finally {
        mockVerify.restore();
        mockRefund.restore();
      }
    });
  },
);
