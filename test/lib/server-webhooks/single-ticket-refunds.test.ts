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
  "server webhooks > single-ticket price-mismatch refunds",
  { db: true },
  () => {
    afterEach(() => {
      resetStripeClient();
    });

    test("single-ticket is kept and refunded when price changed since checkout", async () => {
      await setupStripe();

      const listing = await createTestListing({
        maxAttendees: 50,
        unitPrice: 1000,
      });

      // amountTotal (1200) differs from expectedPrice (1000 * 1 = 1000)
      // Price changed after checkout was created — should refund
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
                  amount_total: 1200,
                  id: "cs_mismatch",
                  metadata: signedMeta(
                    {
                      email: "mismatch@example.com",
                      items: singleItem(listing.id, 1, 1000),
                      name: "Mismatch User",
                    },
                    1200,
                  ),
                  payment_intent: "pi_mismatch",
                  payment_status: "paid",
                },
              },
              id: "evt_mismatch",
              type: "checkout.session.completed",
            },
            valid: true,
          }),
      );

      const mockRefund = stub(stripeApi, "refundPayment", () =>
        Promise.resolve({ id: "re_mismatch" } as unknown as Awaited<
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
            // The price-changed reason now lives in the note; the customer sees
            // the generic saved-details message.
            expect(json.error).toContain("saved your details");
          },
        );

        // Signed by us, so the booking is kept as a quantity-0 placeholder (not
        // dropped) and refunded once, with a system note recording the reason.
        const { getAttendeesRaw } = await import("#shared/db/attendees.ts");
        const attendees = await getAttendeesRaw(listing.id);
        expect(attendees.length).toBe(1);
        expect(attendees[0]!.quantity).toBe(0);
        const { getNoteRows } = await import("#shared/db/system-notes.ts");
        expect((await getNoteRows([attendees[0]!.id])).length).toBe(1);
        const { isSessionProcessed } = await import(
          "#shared/db/processed-payments.ts"
        );
        const record = await isSessionProcessed("cs_mismatch");
        expect(record?.attendee_id).toBeNull();
        expect(record?.failure_data).not.toBe("");

        // Verify refund was attempted exactly once
        expect(mockRefund.calls.length).toBe(1);
        expect(mockRefund.calls[0]!.args).toEqual(["pi_mismatch"]);
      } finally {
        mockVerify.restore();
        mockRefund.restore();
      }
    });

    test("single-ticket redirect keeps the booking and shows the refund message when price changed", async () => {
      await setupStripe();

      const listing = await createTestListing({
        maxAttendees: 50,
        unitPrice: 1000,
      });

      // amountTotal (800) differs from expectedPrice (1000 * 1 = 1000)
      // Price decreased after checkout was created — should refund
      const mockRetrieve = stub(stripeApi, "retrieveCheckoutSession", () =>
        Promise.resolve({
          amount_total: 800,
          id: "cs_redirect_mismatch",
          metadata: signMeta(
            webhookMeta({
              email: "redirect@example.com",
              items: singleItem(listing.id, 1, 1000),
              name: "Redirect Mismatch",
            }),
            800,
          ),
          payment_intent: "pi_redirect_mismatch",
          payment_status: "paid",
        } as unknown as Awaited<
          ReturnType<typeof stripeApi.retrieveCheckoutSession>
        >),
      );

      const mockRefund = stub(stripeApi, "refundPayment", () =>
        Promise.resolve({ id: "re_redirect" } as unknown as Awaited<
          ReturnType<typeof stripeApi.refundPayment>
        >),
      );

      try {
        const response = await handleRequest(
          mockRequest("/payment/success?session_id=cs_redirect_mismatch"),
        );
        // A fully-handled outcome (booking kept, money returned) renders the
        // generic saved-details message with HTTP 200, not a retryable error
        // status. formatPaymentError appends the automatic-refund clause.
        await expectHtmlResponse(
          response,
          200,
          "saved your details",
          "refunded",
        );

        // Signed by us, so the booking is kept as a quantity-0 placeholder (not
        // dropped) and refunded once, with a system note recording the reason.
        const { getAttendeesRaw } = await import("#shared/db/attendees.ts");
        const attendees = await getAttendeesRaw(listing.id);
        expect(attendees.length).toBe(1);
        expect(attendees[0]!.quantity).toBe(0);
        const { getNoteRows } = await import("#shared/db/system-notes.ts");
        expect((await getNoteRows([attendees[0]!.id])).length).toBe(1);
        const { isSessionProcessed } = await import(
          "#shared/db/processed-payments.ts"
        );
        const record = await isSessionProcessed("cs_redirect_mismatch");
        expect(record?.attendee_id).toBeNull();
        expect(record?.failure_data).not.toBe("");

        // Verify refund was attempted exactly once
        expect(mockRefund.calls.length).toBe(1);
        expect(mockRefund.calls[0]!.args).toEqual(["pi_redirect_mismatch"]);
      } finally {
        mockRetrieve.restore();
        mockRefund.restore();
      }
    });

    test("webhook single-ticket defaults email to empty when metadata email is not a string", async () => {
      await setupStripe();

      const listing = await createTestListing({
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
                  id: "cs_wh_no_email_single",
                  metadata: signedMeta(
                    {
                      email: 12345 as unknown as string, // not a string -> coerced to "" by extractSessionMetadata
                      items: singleItem(listing.id, 1, 1000),
                      name: "No Email Single",
                    },
                    1000,
                  ),
                  payment_intent: "pi_wh_no_email_single",
                  payment_status: "paid",
                },
              },
              id: "evt_no_email_single",
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

        const { getAttendeesRaw } = await import("#shared/db/attendees.ts");
        const attendees = await getAttendeesRaw(listing.id);
        expect(attendees.length).toBe(1);
      } finally {
        mockVerify.restore();
      }
    });

    test("webhook multi-ticket defaults email to empty when metadata email is not a string", async () => {
      await setupStripe();

      const listing = await createTestListing({
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
                  amount_total: 500,
                  id: "cs_wh_no_email_multi",
                  metadata: signedMeta(
                    {
                      email: true as unknown as string, // not a string -> coerced to "" by extractSessionMetadata
                      items: JSON.stringify([{ e: listing.id, p: 500, q: 1 }]),
                      name: "No Email Multi",
                    },
                    500,
                  ),
                  payment_intent: "pi_wh_no_email_multi",
                  payment_status: "paid",
                },
              },
              id: "evt_no_email_multi",
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

        const { getAttendeesRaw } = await import("#shared/db/attendees.ts");
        const attendees = await getAttendeesRaw(listing.id);
        expect(attendees.length).toBe(1);
      } finally {
        mockVerify.restore();
      }
    });
  },
);
