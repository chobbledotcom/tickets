import { expect } from "@std/expect";
import { afterEach, it as test } from "@std/testing/bdd";
import { spy, stub } from "@std/testing/mock";
import { handleRequest } from "#routes";
import { resetStripeClient, stripeApi } from "#shared/stripe.ts";
import {
  assertJson,
  createTestListing,
  deactivateTestListing,
  describeWithEnv,
  mockWebhookRequest,
  setupStripe,
  signedMeta,
  singleItem,
  webhookMeta,
} from "#test-utils";

describeWithEnv(
  "server webhooks > refund skip conditions",
  { db: true },
  () => {
    afterEach(() => {
      resetStripeClient();
    });

    test("webhook refund returns false when payment reference is null", async () => {
      await setupStripe();

      const listing = await createTestListing({
        maxAttendees: 50,
        name: "WH Noref",
        unitPrice: 500,
      });
      await deactivateTestListing(listing.id);

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
                  id: "cs_noref",
                  metadata: signedMeta(
                    {
                      email: "noref@example.com",
                      items: singleItem(listing.id, 1, 500),
                      name: "No Ref",
                    },
                    500,
                  ),
                  payment_status: "paid",
                },
              },
              id: "evt_noref",
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
            expect(json.error).toContain("no longer accepting");
          },
        );
      } finally {
        mockVerify.restore();
      }
    });

    test("tryRefund logs error when no payment provider is configured", async () => {
      await setupStripe();

      const listing = await createTestListing({
        maxAttendees: 50,
        name: "WH Tryrefund Noprov",
        unitPrice: 500,
      });
      await deactivateTestListing(listing.id);

      // Mock paymentsApi.getConfiguredProvider to return "stripe" on first call
      // (for webhook handler's initial check) then null on second call (for tryRefund).
      // This covers lines 135-141 where tryRefund has a payment reference but no provider.
      const { paymentsApi } = await import("#shared/payments.ts");
      const origGetConfigured = paymentsApi.getConfiguredProvider;
      let callCount = 0;
      const mockGetConfigured = stub(
        paymentsApi,
        "getConfiguredProvider",
        () => {
          callCount++;
          // First call: webhook handler needs provider; second call: tryRefund should get null
          return callCount <= 1 ? origGetConfigured() : null;
        },
      );

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
                  id: "cs_tryrefund_noprov",
                  metadata: signedMeta(
                    {
                      email: "noprov@example.com",
                      items: singleItem(listing.id, 1, 500),
                      name: "No Provider",
                    },
                    500,
                  ),
                  payment_intent: "pi_tryrefund_noprov",
                  payment_status: "paid",
                },
              },
              id: "evt_tryrefund_noprov",
              type: "checkout.session.completed",
            },
            valid: true,
          }),
      );

      try {
        const response = await handleRequest(
          mockWebhookRequest({}, { "stripe-signature": "sig_valid" }),
        );
        // The payment has a reference but the refund couldn't go through (no
        // provider), so it is retryable: 5xx for the provider to re-deliver once
        // reconfigured, rather than ack a still-charged customer.
        expect(response.status).toBe(503);
        expect(await response.text()).toContain("no longer accepting");
      } finally {
        mockVerify.restore();
        mockGetConfigured.restore();
      }
    });

    test("multi-ticket webhook skips refund when second listing not found", async () => {
      await setupStripe();

      const listing1 = await createTestListing({
        maxAttendees: 50,
        name: "WH Multi Rollback 1",
        unitPrice: 500,
      });
      // listing2 does not exist (id 99999) — validation fails before any attendees are created

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
                  id: "cs_multi_rollback_cleanup",
                  metadata: webhookMeta({
                    email: "rollback@example.com",
                    items: JSON.stringify([
                      { e: listing1.id, p: 500, q: 1 },
                      { e: 99999, p: 0, q: 1 },
                    ]),
                    name: "Rollback Test",
                  }),
                  payment_intent: "pi_multi_rollback",
                  payment_status: "paid",
                },
              },
              id: "evt_multi_rollback",
              type: "checkout.session.completed",
            },
            valid: true,
          }),
      );

      const mockRefund = spy(stripeApi, "refundPayment");

      try {
        // Unsigned session (no valid price proof): ignored (200 ack) without
        // processing, without a refund, and without creating any attendee.
        await assertJson(
          handleRequest(
            mockWebhookRequest({}, { "stripe-signature": "sig_valid" }),
          ),
          200,
          (json) => {
            expect(json.received).toBe(true);
            expect(json.processed).toBeUndefined();
          },
        );

        // An unverifiable session must NOT trigger a refund.
        expect(mockRefund.calls.length).toBe(0);

        // No attendees created (the session is ignored before any creation pass)
        const { getAttendeesRaw } = await import("#shared/db/attendees.ts");
        const attendees = await getAttendeesRaw(listing1.id);
        expect(attendees.length).toBe(0);
      } finally {
        mockVerify.restore();
        mockRefund.restore();
      }
    });
  },
);
