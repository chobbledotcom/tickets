import { expect } from "@std/expect";
import { beforeEach, describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { settings } from "#shared/db/settings.ts";
import { extractSessionMetadata } from "#shared/payment-helpers.ts";
import type { SessionMetadata } from "#shared/payments.ts";
import type { StripeWebhookEvent } from "#shared/stripe.ts";
import {
  constructTestWebhookEvent,
  createCheckoutSession,
  getStripeClient,
  refundPayment,
  resetStripeClient,
  retrieveCheckoutSession,
  verifyWebhookSignature,
} from "#shared/stripe.ts";
import { checkoutIntent, checkoutItem } from "#test-utils/checkout.ts";
import { createTestDb, resetDb } from "#test-utils/db.ts";
import { testListing } from "#test-utils/factories.ts";
import { withMocks } from "#test-utils/mocks.ts";
import { activateStripe } from "#test-utils/settings.ts";
import {
  type CreatedSessionParams,
  lineFor,
  signedHeader,
  stripeClient,
} from "./fixtures.ts";
import { describeStripe } from "./harness.ts";

describeStripe("stripe", () => {
  describe("getStripeClient", () => {
    test("returns null when stripe key not set", async () => {
      const client = await getStripeClient();
      expect(client).toBeNull();
    });

    test("returns client when stripe key is set in database", async () => {
      await settings.update.stripe.secretKey("sk_test_123");
      const client = await getStripeClient();
      expect(client).not.toBeNull();
    });

    test("returns same client on subsequent calls", async () => {
      await settings.update.stripe.secretKey("sk_test_123");
      const client1 = await getStripeClient();
      const client2 = await getStripeClient();
      expect(client1).toBe(client2);
    });
  });

  describe("resetStripeClient", () => {
    test("resets client to null after key removed from db", async () => {
      await settings.update.stripe.secretKey("sk_test_123");
      const client1 = await getStripeClient();
      expect(client1).not.toBeNull();

      resetStripeClient();
      // Reset DB to clear the stripe key
      resetDb();
      await createTestDb();

      const client2 = await getStripeClient();
      expect(client2).toBeNull();
    });
  });

  describe("retrieveCheckoutSession", () => {
    test("returns null when stripe key not set", async () => {
      const result = await retrieveCheckoutSession("cs_test_123");
      expect(result).toBeNull();
    });

    test("returns null when Stripe API throws error", async () => {
      const client = await stripeClient();
      // Spy on the checkout.sessions.retrieve method and make it throw
      await withMocks(
        () =>
          stub(client.checkout.sessions, "retrieve", () =>
            Promise.reject(new Error("Network error")),
          ),
        async (retrieveSpy) => {
          const result = await retrieveCheckoutSession("cs_test_123");
          expect(result).toBeNull();
          expect(retrieveSpy.calls[0]!.args).toEqual(["cs_test_123"]);
        },
      );
    });
  });

  describe("mock configuration", () => {
    test("creates client with mock config when STRIPE_MOCK_HOST is set", async () => {
      // This test exercises the getMockConfig code path
      await settings.update.stripe.secretKey("sk_test_123");
      Deno.env.set("STRIPE_MOCK_HOST", "localhost");
      Deno.env.set("STRIPE_MOCK_PORT", "12111");

      // This will create a client with mock config, but won't make any API calls
      const client = await getStripeClient();
      expect(client).not.toBeNull();
    });

    test("uses default port 12111 when STRIPE_MOCK_PORT not set", async () => {
      await settings.update.stripe.secretKey("sk_test_123");
      Deno.env.set("STRIPE_MOCK_HOST", "localhost");
      Deno.env.delete("STRIPE_MOCK_PORT");

      const client = await getStripeClient();
      expect(client).not.toBeNull();
    });
  });

  describe("stripe-mock integration", () => {
    // These tests use the stripe-mock host and port chosen by the harness.

    test("retrieves checkout session with stripe-mock", async () => {
      await settings.update.stripe.secretKey("sk_test_mock");

      // First create a session using intent-based flow
      const listing = testListing({ unit_price: 1000 });
      const createdSession = await createCheckoutSession(
        checkoutIntent({
          email: "john@example.com",
          items: [lineFor(listing)],
          name: "John Doe",
        }),
        "http://localhost:3000",
      );
      expect(createdSession).not.toBeNull();

      // Then retrieve it
      const retrievedSession = await retrieveCheckoutSession(
        createdSession?.id || "",
      );
      expect(retrievedSession).not.toBeNull();
      expect(retrievedSession?.id).toBe(createdSession?.id);
    });

    test("creates checkout session with intent metadata", async () => {
      await settings.update.stripe.secretKey("sk_test_mock");

      const listing = testListing({ max_quantity: 5, unit_price: 1000 });
      const session = await createCheckoutSession(
        checkoutIntent({
          email: "john@example.com",
          items: [lineFor(listing, 2)],
          name: "John Doe",
        }),
        "http://localhost:3000",
      );

      // stripe-mock creates session successfully but may not return our custom metadata
      expect(session).not.toBeNull();
      expect(session?.id).toBeDefined();
      expect(session?.url).toBeDefined();
    });

    test("refunds payment with stripe-mock", async () => {
      await settings.update.stripe.secretKey("sk_test_mock");

      // stripe-mock accepts any payment_intent ID
      const refund = await refundPayment("pi_test_123");

      expect(refund).not.toBeNull();
      expect(refund?.id).toBeDefined();
    });
  });

  describe("createCheckoutSession", () => {
    /** Stub `sessions.create` to resolve `session`, handing the spy to `run`. */
    const withCreateSpy = (
      client: Awaited<ReturnType<typeof stripeClient>>,
      session: unknown,
      run: (spy: ReturnType<typeof stub>) => Promise<void>,
    ) =>
      withMocks(
        () =>
          stub(client.checkout.sessions, "create", () =>
            Promise.resolve(session as never),
          ) as unknown as ReturnType<typeof stub>,
        run,
      );

    test("returns null when stripe key not set", async () => {
      const result = await createCheckoutSession(
        checkoutIntent({
          email: "john@example.com",
          items: [checkoutItem({ name: "Test", slug: "test-listing" })],
          name: "John",
        }),
        "http://localhost",
      );
      expect(result).toBeNull();
    });

    test("includes booking fee line item when fee is set", async () => {
      const { settings: s } = await import("#shared/db/settings.ts");
      await s.update.bookingFee("5");
      const client = await stripeClient();

      await withCreateSpy(
        client,
        {
          id: "cs_fee",
          object: "checkout.session",
          url: "https://checkout.stripe.com/fee",
        },
        async (createSpy) => {
          const listing = testListing({ unit_price: 1000 });
          const now = Math.floor(Date.now() / 1000);
          await createCheckoutSession(
            checkoutIntent({
              email: "jane@example.com",
              items: [lineFor(listing)],
              name: "Jane",
            }),
            "http://localhost:3000",
          );

          const params = createSpy.calls[0]!
            .args[0] as unknown as CreatedSessionParams & {
            expires_at: number;
          };
          expect(params.expires_at).toBeGreaterThanOrEqual(now + 30 * 60);
          expect(params.expires_at).toBeLessThanOrEqual(now + 31 * 60);
          const feeItem = params.line_items.find(
            (li) => li.price_data.product_data.name === "Booking fee",
          );
          expect(feeItem).toBeDefined();
          // 5% of 1000 = 50
          expect(feeItem!.price_data.unit_amount).toBe(50);
          expect(feeItem!.quantity).toBe(1);
        },
      );
    });

    test("charges the deposit per ticket but the fee on the full order", async () => {
      const { settings: s } = await import("#shared/db/settings.ts");
      await s.update.bookingFee("5");
      const client = await stripeClient();

      await withCreateSpy(
        client,
        {
          id: "cs_dep",
          object: "checkout.session",
          url: "https://checkout.stripe.com/dep",
        },
        async (createSpy) => {
          const listing = testListing({ unit_price: 1000 });
          await createCheckoutSession(
            checkoutIntent({
              email: "jane@example.com",
              items: [lineFor(listing, 2)],
              name: "Jane",
              // Public-default reservation charges a 10% deposit up front.
              reservationAmount: "10%",
            }),
            "http://localhost:3000",
          );

          const params = createSpy.calls[0]!
            .args[0] as unknown as CreatedSessionParams;
          const ticketItem = params.line_items.find((li) =>
            li.price_data.product_data.name.startsWith("Ticket:"),
          );
          const feeItem = params.line_items.find(
            (li) => li.price_data.product_data.name === "Booking fee",
          );
          // Ticket line is charged the per-unit deposit (10% of £10.00 = £1.00).
          expect(ticketItem!.price_data.unit_amount).toBe(100);
          expect(ticketItem!.quantity).toBe(2);
          // Fee is still 5% of the full £20.00 order, not of the deposit.
          expect(feeItem!.price_data.unit_amount).toBe(100);
          // Metadata records the FULL line price + the snapshot so the webhook
          // can re-derive the deposit and compute the outstanding balance. The
          // snapshot is packed into `b` on the wire; decode it the way the
          // webhook does rather than reading the raw entry.
          const metadata = extractSessionMetadata(
            params.metadata as unknown as SessionMetadata,
          );
          expect(JSON.parse(metadata.items)).toEqual([
            { e: listing.id, p: 2000, q: 2 },
          ]);
          expect(metadata.reservation_amount).toBe("10%");
        },
      );
    });
  });

  describe("refundPayment", () => {
    test("returns null when stripe key not set", async () => {
      const result = await refundPayment("pi_test_123");
      expect(result).toBeNull();
    });

    test("returns null when Stripe API throws error", async () => {
      const client = await stripeClient();
      await withMocks(
        () =>
          stub(client.refunds, "create", () =>
            Promise.reject(new Error("Network error")),
          ),
        async (refundSpy) => {
          const result = await refundPayment("pi_test_123");
          expect(result).toBeNull();
          expect(refundSpy.calls.length).toBeGreaterThan(0);
        },
      );
    });
  });

  describe("verifyWebhookSignature", () => {
    const TEST_SECRET = "whsec_test_secret_key_for_webhook_verification";

    beforeEach(async () => {
      // Set webhook secret in database (encrypted)
      await activateStripe(TEST_SECRET);
    });

    test("returns error when webhook secret not configured", async () => {
      // Reset DB to have no webhook secret configured
      await resetDb();
      await createTestDb();
      const result = await verifyWebhookSignature(
        '{"test": true}',
        "t=1234,v1=abc",
      );
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toBe("Webhook secret not configured");
      }
    });

    test("returns error for invalid signature header format", async () => {
      const result = await verifyWebhookSignature(
        '{"test": true}',
        "invalid-header",
      );
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toBe("Invalid signature header format");
      }
    });

    test("returns error for missing timestamp in header", async () => {
      const result = await verifyWebhookSignature(
        '{"test": true}',
        "v1=abc123",
      );
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toBe("Invalid signature header format");
      }
    });

    test("returns error for missing signature in header", async () => {
      const result = await verifyWebhookSignature('{"test": true}', "t=1234");
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toBe("Invalid signature header format");
      }
    });

    test("returns error for timestamp outside tolerance window", async () => {
      // Sign with an old timestamp (more than 5 minutes ago)
      const oldTimestamp = Math.floor(Date.now() / 1000) - 400; // 400 seconds ago
      const payload = '{"test": true}';
      const result = await verifyWebhookSignature(
        payload,
        await signedHeader(TEST_SECRET, payload, oldTimestamp),
      );
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toBe("Timestamp outside tolerance window");
      }
    });

    test("returns error for invalid signature", async () => {
      const timestamp = Math.floor(Date.now() / 1000);
      const result = await verifyWebhookSignature(
        '{"test": true}',
        `t=${timestamp},v1=invalid_signature_that_wont_match`,
      );
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toBe("Signature verification failed");
      }
    });

    test("returns error for invalid JSON payload", async () => {
      const payload = "not valid json {{{";
      const result = await verifyWebhookSignature(
        payload,
        await signedHeader(TEST_SECRET, payload),
      );
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toBe("Invalid JSON payload");
      }
    });

    test("verifies valid signature successfully", async () => {
      const listing: StripeWebhookEvent = {
        data: {
          object: {
            id: "cs_test_123",
            metadata: {
              email: "john@example.com",
              items: '[{"e":1,"q":1,"p":0}]',
              name: "John Doe",
            },
            payment_status: "paid",
          },
        },
        id: "evt_test_123",
        type: "checkout.session.completed",
      };

      const { payload, signature } = await constructTestWebhookEvent(
        listing,
        TEST_SECRET,
      );

      const result = await verifyWebhookSignature(payload, signature);
      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.listing.id).toBe("evt_test_123");
        expect(result.listing.type).toBe("checkout.session.completed");
      }
    });

    test("accepts custom tolerance window", async () => {
      // Sign with a timestamp 100 seconds ago
      const oldTimestamp = Math.floor(Date.now() / 1000) - 100;
      const payload = '{"id": "evt_123", "type": "test"}';
      const header = await signedHeader(TEST_SECRET, payload, oldTimestamp);

      // Should fail with a tight tolerance but pass with a generous one
      const resultWithSmallTolerance = await verifyWebhookSignature(
        payload,
        header,
        50, // 50 second tolerance - should fail
      );
      expect(resultWithSmallTolerance.valid).toBe(false);

      const resultWithLargeTolerance = await verifyWebhookSignature(
        payload,
        header,
        200, // 200 second tolerance - should pass
      );
      expect(resultWithLargeTolerance.valid).toBe(true);
    });
  });
});
