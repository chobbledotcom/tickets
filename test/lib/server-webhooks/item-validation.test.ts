import { expect } from "@std/expect";
import { afterEach, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { handleRequest } from "#routes";
import { resetStripeClient } from "#shared/stripe.ts";
import {
  assertJson,
  createTestListing,
  describeWithEnv,
  mockWebhookRequest,
  setupStripe,
  stubWebhookVerify,
  webhookMeta,
} from "#test-utils";

describeWithEnv(
  "server webhooks > item metadata validation",
  { db: true },
  () => {
    afterEach(() => {
      resetStripeClient();
    });

    test("corrupt booking item in metadata throws (missing p)", async () => {
      await setupStripe();

      const listing1 = await createTestListing({
        maxAttendees: 50,
        name: "No Price Multi",
        unitPrice: 500,
      });

      // Items without a p field can't carry a valid price proof, so the session
      // has no proof and classifies as "ignore": acknowledged (200) without
      // processing or refunding, never a throw.
      const mockVerify = await stubWebhookVerify({
        data: {
          object: {
            amount_total: 500,
            id: "cs_no_price",
            metadata: webhookMeta({
              email: "noprice@example.com",
              items: JSON.stringify([{ e: listing1.id, q: 1 }]),
              name: "No Price User",
            }),
            payment_intent: "pi_no_price",
            payment_status: "paid",
          },
        },
        id: "evt_no_price",
        type: "checkout.session.completed",
      });

      try {
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
        const { getAttendeesRaw } = await import("#shared/db/attendees.ts");
        expect((await getAttendeesRaw(listing1.id)).length).toBe(0);
      } finally {
        mockVerify.restore();
      }
    });

    test("webhook returns error for invalid multi-ticket items", async () => {
      await setupStripe();

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
                  amount_total: 0,
                  id: "cs_bad_multi",
                  metadata: webhookMeta({
                    email: "bad@example.com",
                    items: "not-valid-json{",
                    name: "Bad Multi",
                  }),
                  payment_intent: "pi_bad",
                  payment_status: "paid",
                },
              },
              id: "evt_bad_multi",
              type: "checkout.session.completed",
            },
            valid: true,
          }),
      );

      try {
        // Unparseable items can't carry a valid price proof, so the session has
        // no proof and is ignored: acknowledged (200) without processing.
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
      } finally {
        mockVerify.restore();
      }
    });

    test("webhook with non-array items in multi-ticket returns null", async () => {
      await setupStripe();

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
                  amount_total: 0,
                  id: "cs_non_array",
                  metadata: webhookMeta({
                    email: "test@example.com",
                    items: '{"not":"an-array"}', // Valid JSON but not an array
                    name: "Test",
                  }),
                  payment_intent: "pi_non_array",
                  payment_status: "paid",
                },
              },
              id: "evt_non_array",
              type: "checkout.session.completed",
            },
            valid: true,
          }),
      );

      try {
        // Non-array items can't carry a valid price proof, so the session has no
        // proof and is ignored: acknowledged (200) without processing.
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
      } finally {
        mockVerify.restore();
      }
    });

    test("webhook with missing items in multi-ticket metadata acknowledges without processing", async () => {
      await setupStripe();

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
                  amount_total: 0,
                  id: "cs_no_items",
                  metadata: webhookMeta({
                    email: "test@example.com",
                    items: "", // empty items: hasRequiredSessionMetadata rejects (no items)
                    name: "Test",
                  }),
                  payment_intent: "pi_no_items",
                  payment_status: "paid",
                },
              },
              id: "evt_no_items",
              type: "checkout.session.completed",
            },
            valid: true,
          }),
      );

      try {
        // Returns 200 to prevent provider retries
        await assertJson(
          handleRequest(
            mockWebhookRequest({}, { "stripe-signature": "sig_valid" }),
          ),
          200,
          (json) => {
            expect(json.received).toBe(true);
          },
        );
      } finally {
        mockVerify.restore();
      }
    });

    test("webhook returns 400 when items is missing from metadata", async () => {
      await setupStripe();

      // Session with missing items carries no valid price proof, so it can't be
      // proven ours and is ignored: acknowledged (200) without processing.
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
                  id: "cs_no_listing_id",
                  status: "COMPLETED",
                },
              },
              id: "evt_no_eid",
              type: "checkout.session.completed",
            },
            valid: true,
          }),
      );

      const mockRetrieveSession = stub(
        stripePaymentProvider,
        "retrieveSession",
        () =>
          Promise.resolve({
            amountTotal: 0,
            id: "cs_no_listing_id",
            metadata: webhookMeta({
              email: "nolistingid@example.com",
              name: "No ListingId",
              // items missing — invalid session data
            }),
            paymentReference: "pi_no_listing_id",
            paymentStatus: "paid" as const,
          }),
      );

      try {
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
      } finally {
        mockVerify.restore();
        mockRetrieveSession.restore();
      }
    });

    test("corrupt booking item in metadata throws (non-integer p)", async () => {
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
                  id: "cs_bad_p",
                  metadata: webhookMeta({
                    email: "bad@example.com",
                    items: JSON.stringify([{ e: listing.id, p: 10.5, q: 1 }]),
                    name: "Bad Metadata",
                  }),
                  payment_intent: "pi_bad_p",
                  payment_status: "paid",
                },
              },
              id: "evt_bad_p",
              type: "checkout.session.completed",
            },
            valid: true,
          }),
      );

      try {
        // A corrupt session can't carry a valid price proof, so it has no proof
        // and is ignored: acknowledged (200) without processing, no throw.
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
        const { getAttendeesRaw } = await import("#shared/db/attendees.ts");
        expect((await getAttendeesRaw(listing.id)).length).toBe(0);
      } finally {
        mockVerify.restore();
      }
    });

    test("corrupt booking item in metadata throws (non-object item)", async () => {
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
                  id: "cs_bad_item",
                  metadata: webhookMeta({
                    email: "bad@example.com",
                    items: JSON.stringify([
                      42,
                      { e: listing.id, p: 1000, q: 1 },
                    ]),
                    name: "Bad Item",
                  }),
                  payment_intent: "pi_bad_item",
                  payment_status: "paid",
                },
              },
              id: "evt_bad_item",
              type: "checkout.session.completed",
            },
            valid: true,
          }),
      );

      try {
        // A corrupt session can't carry a valid price proof, so it has no proof
        // and is ignored: acknowledged (200) without processing, no throw.
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
        const { getAttendeesRaw } = await import("#shared/db/attendees.ts");
        expect((await getAttendeesRaw(listing.id)).length).toBe(0);
      } finally {
        mockVerify.restore();
      }
    });
  },
);
