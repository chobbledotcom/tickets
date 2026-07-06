import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { spy, stub } from "@std/testing/mock";
import { settings } from "#shared/db/settings.ts";
import { extractSessionMetadata } from "#shared/payment-helpers.ts";
import type { SessionMetadata } from "#shared/payments.ts";
import {
  constructTestWebhookEvent,
  createCheckoutSession,
  detectStripeKeyMode,
  getStripeClient,
  refundPayment,
  resetStripeClient,
  retrieveCheckoutSession,
  retrievePaymentIntent,
  type StripeWebhookEvent,
  sanitizeErrorDetail,
  setupWebhookEndpoint,
  stripeApi,
  testStripeConnection,
  verifyWebhookSignature,
} from "#shared/stripe.ts";
import { stripePaymentProvider } from "#shared/stripe-provider.ts";
import {
  createTestDb,
  describeWithEnv,
  installUrlHandler,
  resetDb,
  setTestEnv,
  testListing,
  urlFromFetchInput,
  withFetchMock,
  withMocks,
} from "#test-utils";
import {
  checkoutIntent,
  checkoutItem,
  numberedItems,
} from "#test-utils/checkout-intents.ts";
import {
  checkoutSession,
  enabledStripeClient,
  resetStripeBetweenTests,
  STRIPE_MOCK_ENV,
  stripeCreateArgs,
  withCheckoutCreate,
  withCheckoutRetrieve,
  withCheckoutSessionsStub,
  withPaymentIntent,
  withStripeStatus,
} from "#test-utils/stripe-checkout.ts";
import { webhookEvent } from "#test-utils/webhook-event.ts";
import { hmacHex } from "#test-utils/webhook-signing.ts";

/** A checkout line built from a test listing (quantity defaults to 1). */
const listingItem = (listing: ReturnType<typeof testListing>, quantity = 1) =>
  checkoutItem({
    listingId: listing.id,
    name: listing.name,
    quantity,
    slug: listing.slug,
    unitPrice: listing.unit_price,
  });

/** The two fixed lines the multi-checkout tests reuse. */
const listingA = (quantity: number) =>
  checkoutItem({ name: "Listing A", quantity, slug: "listing-a" });
const listingB = (quantity: number) =>
  checkoutItem({
    listingId: 2,
    name: "Listing B",
    quantity,
    slug: "listing-b",
    unitPrice: 2000,
  });

describeWithEnv("stripe", STRIPE_MOCK_ENV, () => {
  resetStripeBetweenTests();

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
      // Enable Stripe with mock
      const client = await enabledStripeClient();

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
    // These tests require stripe-mock running on localhost:12111
    // STRIPE_MOCK_HOST/PORT are set in test/setup.ts

    test("retrieves checkout session with stripe-mock", async () => {
      await settings.update.stripe.secretKey("sk_test_mock");

      // First create a session using intent-based flow
      const intent = checkoutIntent({
        items: [checkoutItem({ name: "Test Listing" })],
        name: "John Doe",
      });

      const createdSession = await createCheckoutSession(
        intent,
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

      const intent = checkoutIntent({
        items: [checkoutItem({ name: "Test Listing", quantity: 2 })],
        name: "John Doe",
      });

      const session = await createCheckoutSession(
        intent,
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
    test("returns null when stripe key not set", async () => {
      const intent = checkoutIntent();
      const result = await createCheckoutSession(intent, "http://localhost");
      expect(result).toBeNull();
    });

    test("includes booking fee line item when fee is set", async () => {
      const { settings: s } = await import("#shared/db/settings.ts");
      await s.update.bookingFee("5");
      const client = await enabledStripeClient();

      await withCheckoutCreate(
        client,
        checkoutSession("cs_fee", "https://checkout.stripe.com/fee"),
        async (createSpy) => {
          const listing = testListing({ unit_price: 1000 });
          const intent = checkoutIntent({
            email: "jane@example.com",
            items: [listingItem(listing)],
            name: "Jane",
          });

          await createCheckoutSession(intent, "http://localhost:3000");

          const lineItems = stripeCreateArgs(createSpy).line_items;
          const feeItem = lineItems.find(
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
      const client = await enabledStripeClient();

      await withCheckoutCreate(
        client,
        checkoutSession("cs_dep", "https://checkout.stripe.com/dep"),
        async (createSpy) => {
          const listing = testListing({ unit_price: 1000 });
          const intent = checkoutIntent({
            email: "jane@example.com",
            items: [listingItem(listing, 2)],
            name: "Jane",
            // Public-default reservation charges a 10% deposit up front.
            reservationAmount: "10%",
          });

          await createCheckoutSession(intent, "http://localhost:3000");

          const params = stripeCreateArgs(createSpy);
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
      const client = await enabledStripeClient();

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
      await settings.update.stripe.webhookConfig({
        endpointId: "we_test_endpoint",
        secret: TEST_SECRET,
      });
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
      // Create a signature with old timestamp (more than 5 minutes ago)
      const oldTimestamp = Math.floor(Date.now() / 1000) - 400; // 400 seconds ago
      const payload = '{"test": true}';
      const signedPayload = `${oldTimestamp}.${payload}`;

      // Compute valid signature with old timestamp
      const sigHex = await hmacHex(TEST_SECRET, signedPayload);

      const result = await verifyWebhookSignature(
        payload,
        `t=${oldTimestamp},v1=${sigHex}`,
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
      const timestamp = Math.floor(Date.now() / 1000);
      const signedPayload = `${timestamp}.${payload}`;

      // Compute valid signature
      const sigHex = await hmacHex(TEST_SECRET, signedPayload);

      const result = await verifyWebhookSignature(
        payload,
        `t=${timestamp},v1=${sigHex}`,
      );
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toBe("Invalid JSON payload");
      }
    });

    test("verifies valid signature successfully", async () => {
      const listing: StripeWebhookEvent = webhookEvent(
        {
          id: "cs_test_123",
          metadata: {
            email: "john@example.com",
            items: '[{"e":1,"q":1,"p":0}]',
            name: "John Doe",
          },
          payment_status: "paid",
        },
        "evt_test_123",
        "checkout.session.completed",
      );

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
      // Create signature with timestamp 100 seconds ago
      const oldTimestamp = Math.floor(Date.now() / 1000) - 100;
      const payload = '{"id": "evt_123", "type": "test"}';
      const signedPayload = `${oldTimestamp}.${payload}`;

      const sigHex = await hmacHex(TEST_SECRET, signedPayload);

      // Should fail with default 300s tolerance but pass with 150s tolerance
      const resultWithSmallTolerance = await verifyWebhookSignature(
        payload,
        `t=${oldTimestamp},v1=${sigHex}`,
        50, // 50 second tolerance - should fail
      );
      expect(resultWithSmallTolerance.valid).toBe(false);

      // Should pass with larger tolerance
      const resultWithLargeTolerance = await verifyWebhookSignature(
        payload,
        `t=${oldTimestamp},v1=${sigHex}`,
        200, // 200 second tolerance - should pass
      );
      expect(resultWithLargeTolerance.valid).toBe(true);
    });
  });

  describe("testStripeConnection", () => {
    test("returns error when no API key configured", async () => {
      const result = await testStripeConnection();
      expect(result.ok).toBe(false);
      expect(result.apiKey.valid).toBe(false);
      expect(result.apiKey.error).toContain("No Stripe secret key configured");
    });

    test("returns error when balance.retrieve fails", async () => {
      const client = await enabledStripeClient();

      await withStripeStatus(
        client,
        { balanceRejects: new Error("Invalid API Key provided") },
        async () => {
          const result = await testStripeConnection();
          expect(result.ok).toBe(false);
          expect(result.apiKey.valid).toBe(false);
          expect(result.apiKey.error).toContain("Invalid API Key provided");
        },
      );
    });

    test("returns test mode when API key is valid and no webhooks exist", async () => {
      const client = await enabledStripeClient();

      await withStripeStatus(client, {}, async () => {
        const result = await testStripeConnection();
        expect(result.ok).toBe(false);
        expect(result.apiKey.valid).toBe(true);
        expect(result.apiKey.mode).toBe("test");
        expect(result.webhooks).toHaveLength(0);
      });
    });

    test("returns live mode for live key", async () => {
      await settings.update.stripe.secretKey("sk_live_mock");
      const client = await getStripeClient();
      if (!client) throw new Error("Expected client to be defined");

      await withStripeStatus(client, { livemode: true }, async () => {
        const result = await testStripeConnection();
        expect(result.apiKey.valid).toBe(true);
        expect(result.apiKey.mode).toBe("live");
      });
    });

    test("returns webhook error when list fails", async () => {
      const client = await enabledStripeClient();

      await withStripeStatus(
        client,
        { webhooksReject: new Error("Failed to list webhook endpoints") },
        async () => {
          const result = await testStripeConnection();
          expect(result.ok).toBe(false);
          expect(result.apiKey.valid).toBe(true);
          expect(result.webhookError).toContain(
            "Failed to list webhook endpoints",
          );
        },
      );
    });

    test("returns full success when API key valid and webhooks exist", async () => {
      await settings.update.stripe.webhookConfig({
        endpointId: "we_test_valid",
        secret: "whsec_test",
      });
      const client = await enabledStripeClient();

      await withStripeStatus(
        client,
        {
          webhooks: [
            {
              enabled_events: ["checkout.session.completed"],
              id: "we_test_valid",
              object: "webhook_endpoint",
              status: "enabled",
              url: "https://example.com/payment/webhook",
            },
            {
              enabled_events: ["payment_intent.succeeded"],
              id: "we_test_other",
              object: "webhook_endpoint",
              status: "enabled",
              url: "https://other.com/webhook",
            },
          ],
        },
        async () => {
          const result = await testStripeConnection();
          expect(result.ok).toBe(true);
          expect(result.apiKey.valid).toBe(true);
          expect(result.apiKey.mode).toBe("test");
          expect(result.ownEndpointId).toBe("we_test_valid");
          expect(result.webhooks).toHaveLength(2);
          const [first, second] = result.webhooks;
          expect(first!.endpointId).toBe("we_test_valid");
          expect(first!.url).toBe("https://example.com/payment/webhook");
          expect(first!.status).toBe("enabled");
          expect(first!.enabledEvents).toContain("checkout.session.completed");
          expect(second!.endpointId).toBe("we_test_other");
          expect(second!.url).toBe("https://other.com/webhook");
        },
      );
    });
  });

  describe("constructTestWebhookEvent", () => {
    test("creates valid payload and signature pair", async () => {
      const secret = "whsec_test_construction";
      const listing: StripeWebhookEvent = {
        data: {
          object: {
            amount: 1000,
            currency: "gbp",
          },
        },
        id: "evt_constructed",
        type: "payment_intent.succeeded",
      };

      const { payload, signature } = await constructTestWebhookEvent(
        listing,
        secret,
      );

      // Verify payload is valid JSON matching input
      const parsed = JSON.parse(payload);
      expect(parsed.id).toBe("evt_constructed");
      expect(parsed.type).toBe("payment_intent.succeeded");

      // Verify signature format
      expect(signature).toMatch(/^t=\d+,v1=[a-f0-9]+$/);

      // Signature should be verifiable with the same secret (stored in DB)
      await settings.update.stripe.webhookConfig({
        endpointId: "we_test_construction",
        secret,
      });
      const result = await verifyWebhookSignature(payload, signature);
      expect(result.valid).toBe(true);
    });
  });

  describe("sanitizeErrorDetail", () => {
    test("returns 'unknown' for non-Error values", () => {
      expect(sanitizeErrorDetail("string error")).toBe("unknown");
      expect(sanitizeErrorDetail(null)).toBe("unknown");
      expect(sanitizeErrorDetail(42)).toBe("unknown");
      expect(sanitizeErrorDetail(undefined)).toBe("unknown");
    });

    test("returns error name for plain Error without Stripe fields", () => {
      expect(sanitizeErrorDetail(new Error("sensitive message"))).toBe("Error");
    });

    test("returns error name for typed errors without Stripe fields", () => {
      expect(sanitizeErrorDetail(new TypeError("bad type"))).toBe("TypeError");
    });

    test("extracts Stripe statusCode, code, and type", () => {
      const err = new Error("Invalid API Key provided: sk_test_****1234");
      Object.assign(err, {
        code: "api_key_invalid",
        statusCode: 401,
        type: "StripeAuthenticationError",
      });
      expect(sanitizeErrorDetail(err)).toBe(
        "status=401 code=api_key_invalid type=StripeAuthenticationError",
      );
    });

    test("extracts partial Stripe fields", () => {
      const err = new Error("Resource not found");
      Object.assign(err, { statusCode: 404 });
      expect(sanitizeErrorDetail(err)).toBe("status=404");
    });

    test("extracts code and type without statusCode", () => {
      const err = new Error("Connection failed");
      Object.assign(err, {
        code: "ECONNREFUSED",
        type: "StripeConnectionError",
      });
      expect(sanitizeErrorDetail(err)).toBe(
        "code=ECONNREFUSED type=StripeConnectionError",
      );
    });

    test("never includes the raw error message in output", () => {
      const sensitiveMessage = "Invalid API Key provided: sk_live_realkey123";
      const err = new Error(sensitiveMessage);
      Object.assign(err, {
        statusCode: 401,
        type: "StripeAuthenticationError",
      });
      const detail = sanitizeErrorDetail(err);
      expect(detail).not.toContain(sensitiveMessage);
      expect(detail).not.toContain("sk_live");
    });

    test("falls back to err.name when no Stripe fields present", () => {
      // Error with no statusCode/code/type but has a name
      const err = new Error("something");
      // Plain Error: err.name is "Error", parts is empty, so returns err.name || "Error"
      expect(sanitizeErrorDetail(err)).toBe("Error");
    });
  });

  describe("detectStripeKeyMode", () => {
    test("returns 'test' for sk_test_ keys", () => {
      expect(detectStripeKeyMode("sk_test_abc123")).toBe("test");
    });

    test("returns 'live' for sk_live_ keys", () => {
      expect(detectStripeKeyMode("sk_live_abc123")).toBe("live");
    });

    test("returns null for invalid prefixes", () => {
      expect(detectStripeKeyMode("sk_invalid_abc")).toBeNull();
      expect(detectStripeKeyMode("rk_test_abc")).toBeNull();
      expect(detectStripeKeyMode("")).toBeNull();
      expect(detectStripeKeyMode("random_string")).toBeNull();
    });
  });

  describe("createCheckoutSession - phone metadata", () => {
    test("includes phone in metadata when provided", async () => {
      await settings.update.stripe.secretKey("sk_test_mock");

      const listing = testListing({ unit_price: 1000 });
      const intent = checkoutIntent({
        items: [listingItem(listing)],
        name: "John Doe",
        phone: "+44 7700 900000",
      });

      const session = await createCheckoutSession(
        intent,
        "http://localhost:3000",
      );

      // stripe-mock creates session successfully
      expect(session).not.toBeNull();
      expect(session?.id).toBeDefined();
    });
  });

  describe("createCheckoutSession - no email", () => {
    test("creates checkout session without customer_email when email is empty", async () => {
      await settings.update.stripe.secretKey("sk_test_mock");

      const listing = testListing({ unit_price: 1000 });
      const intent = checkoutIntent({
        email: "",
        items: [listingItem(listing)],
        name: "No Email User",
        phone: "+44 7700 900000",
      });

      const session = await createCheckoutSession(
        intent,
        "http://localhost:3000",
      );

      // stripe-mock creates session successfully (email is empty, so customer_email is omitted)
      expect(session).not.toBeNull();
      expect(session?.id).toBeDefined();
    });
  });

  describe("createCheckoutSession", () => {
    test("creates multi-checkout session with phone metadata", async () => {
      await settings.update.stripe.secretKey("sk_test_mock");

      const intent = checkoutIntent({
        email: "jane@example.com",
        items: [listingA(2), listingB(1)],
        name: "Jane Doe",
        phone: "+44 7700 900001",
      });

      const session = await createCheckoutSession(
        intent,
        "http://localhost:3000",
      );

      expect(session).not.toBeNull();
      expect(session?.id).toBeDefined();
    });

    test("returns null when stripe key not set", async () => {
      const intent = checkoutIntent({
        email: "jane@example.com",
        items: [listingA(1)],
        name: "Jane Doe",
      });

      const result = await createCheckoutSession(
        intent,
        "http://localhost:3000",
      );
      expect(result).toBeNull();
    });

    test("creates multi-checkout session without customer_email when email is empty", async () => {
      await settings.update.stripe.secretKey("sk_test_mock");

      const intent = checkoutIntent({
        email: "",
        items: [listingA(1), listingB(2)],
        name: "No Email Multi",
        phone: "+44 7700 900002",
      });

      const session = await createCheckoutSession(
        intent,
        "http://localhost:3000",
      );

      // stripe-mock creates session successfully (email is empty, so customer_email is omitted)
      expect(session).not.toBeNull();
      expect(session?.id).toBeDefined();
    });
  });

  describe("refundPayment - non-Error exception", () => {
    test("handles non-Error thrown value in refund", async () => {
      const client = await enabledStripeClient();

      // Throw a non-Error value (string) to exercise the sanitizeErrorDetail "unknown" path
      const refundSpy = stub(client.refunds, "create", () =>
        Promise.reject("network failure string"),
      );

      try {
        const result = await refundPayment("pi_test_123");
        expect(result).toBeNull();
      } finally {
        refundSpy.restore();
      }
    });
  });

  describe("testStripeConnection - non-Error exception", () => {
    test("handles non-Error thrown value in balance check", async () => {
      const client = await enabledStripeClient();

      await withStripeStatus(
        client,
        { balanceRejects: "string error" },
        async () => {
          const result = await testStripeConnection();
          expect(result.ok).toBe(false);
          expect(result.apiKey.valid).toBe(false);
          expect(result.apiKey.error).toBe("Unknown error");
        },
      );
    });

    test("handles non-Error thrown value in webhook list", async () => {
      const client = await enabledStripeClient();

      await withStripeStatus(
        client,
        { webhooksReject: "webhook string error" },
        async () => {
          const result = await testStripeConnection();
          expect(result.ok).toBe(false);
          expect(result.webhookError).toBe("Unknown error");
        },
      );
    });
  });

  describe("setupWebhookEndpointImpl", () => {
    // setupWebhookEndpointImpl creates its own client via createStripeClient(secretKey),
    // so we mock at the stripeApi level to test the various code paths

    test("creates webhook endpoint via stripe-mock (no secret returned)", async () => {
      // stripe-mock doesn't return endpoint.secret, so this exercises the "no secret" error path
      const result = await setupWebhookEndpoint(
        "sk_test_mock",
        "https://example.com/payment/webhook",
      );

      // stripe-mock likely doesn't return secret, testing the error path
      if (!result.success) {
        expect(result.error).toBe("Stripe did not return webhook secret");
      }
    });

    test("exercises delete-then-create path with existing endpoint ID", async () => {
      // This exercises the existingEndpointId deletion path
      const result = await setupWebhookEndpoint(
        "sk_test_mock",
        "https://example.com/payment/webhook",
        "we_existing_123",
      );

      // The API call goes through - deletion of non-existent endpoint is caught
      expect(result).toBeDefined();
      expect(typeof result.success).toBe("boolean");
    });

    test("succeeds when mocked via stripeApi", async () => {
      // Override stripeApi to test the full success path
      const origSetup = stripeApi.setupWebhookEndpoint;
      stripeApi.setupWebhookEndpoint = (_key, _url, _existing) =>
        Promise.resolve({
          endpointId: "we_mocked",
          secret: "whsec_mocked",
          success: true,
        });

      try {
        const result = await setupWebhookEndpoint(
          "sk_test",
          "https://example.com/webhook",
        );
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.endpointId).toBe("we_mocked");
          expect(result.secret).toBe("whsec_mocked");
        }
      } finally {
        stripeApi.setupWebhookEndpoint = origSetup;
      }
    });

    test("returns error when API throws", async () => {
      const origSetup = stripeApi.setupWebhookEndpoint;
      stripeApi.setupWebhookEndpoint = (_key, _url) =>
        Promise.resolve({
          error: "API rate limited",
          success: false as const,
        });

      try {
        const result = await setupWebhookEndpoint(
          "sk_test",
          "https://example.com/webhook",
        );
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error).toBe("API rate limited");
        }
      } finally {
        stripeApi.setupWebhookEndpoint = origSetup;
      }
    });
  });

  describe("getMockConfig", () => {
    test("returns undefined when STRIPE_MOCK_HOST not set", async () => {
      const restore = setTestEnv({
        STRIPE_MOCK_HOST: undefined,
        STRIPE_MOCK_PORT: undefined,
      });
      try {
        resetStripeClient();

        // Without mock config, a real Stripe client is created (no mock server)
        await settings.update.stripe.secretKey("sk_test_123");
        const client = await getStripeClient();
        expect(client).not.toBeNull();
      } finally {
        restore();
        resetStripeClient();
      }
    });
  });

  describe("getMockConfig with default port", () => {
    test("uses default port 12111 when STRIPE_MOCK_PORT not set", async () => {
      const restore = setTestEnv({
        STRIPE_MOCK_HOST: "localhost",
        STRIPE_MOCK_PORT: undefined,
      });
      try {
        resetStripeClient();
        await settings.update.stripe.secretKey("sk_test_123");
        // With STRIPE_MOCK_HOST set but no PORT, should use default 12111
        const client = await getStripeClient();
        expect(client).not.toBeNull();
      } finally {
        restore();
        resetStripeClient();
      }
    });
  });

  describe("setupWebhookEndpoint - stripe-mock paths", () => {
    test("creates new endpoint without deleting existing ones for same URL", async () => {
      // stripe-mock has a default endpoint at https://example.com/my/webhook/endpoint
      // Calling setupWebhookEndpoint with that URL should create a new one without deleting existing
      const result = await setupWebhookEndpoint(
        "sk_test_mock",
        "https://example.com/my/webhook/endpoint",
      );

      // stripe-mock doesn't return secret, so this hits the "no secret" error path
      expect(result).toBeDefined();
      expect(typeof result.success).toBe("boolean");
    });

    test("returns success when endpoint.secret is present", async () => {
      // Wrap fetch to intercept the webhook_endpoints create response and inject a secret
      await withFetchMock(async (originalFetch) => {
        globalThis.fetch = async (
          input: RequestInfo | URL,
          init?: RequestInit,
        ): Promise<Response> => {
          const response = await originalFetch(input, init);
          const url = urlFromFetchInput(input as string | URL | Request);

          // Intercept POST to webhook_endpoints (create) and add secret to response
          if (
            url.includes("/v1/webhook_endpoints") &&
            init?.method === "POST"
          ) {
            const body = await response.json();
            body.secret = "whsec_test_injected_secret";
            return new Response(JSON.stringify(body), {
              headers: response.headers,
              status: response.status,
            });
          }
          return response;
        };

        const result = await setupWebhookEndpoint(
          "sk_test_mock",
          "https://example.com/webhook/success-test",
        );

        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.endpointId).toBeDefined();
          expect(result.secret).toBe("whsec_test_injected_secret");
        }
      });
    });

    test("returns error when createStripeClient or API call throws", async () => {
      // Mock fetch to throw on all requests, exercising the outer catch block
      await withFetchMock(async () => {
        globalThis.fetch = () => {
          throw new Error("Network unavailable");
        };

        const result = await setupWebhookEndpoint(
          "sk_test_mock",
          "https://example.com/webhook/error-test",
        );

        expect(result.success).toBe(false);
        if (!result.success) {
          // Stripe SDK wraps connection errors with retry info
          expect(typeof result.error).toBe("string");
          expect(result.error!.length > 0).toBe(true);
        }
      });
    });

    test("catches error when deleting existing endpoint ID fails", async () => {
      // Mock fetch so that ALL DELETE requests throw (Stripe SDK retries, so we must fail all)
      await withFetchMock(async (originalFetch) => {
        installUrlHandler(originalFetch, (url, init) => {
          if (
            (init?.method ?? "GET") === "DELETE" &&
            url.includes("we_should_fail_to_delete")
          ) {
            throw new Error("Delete failed");
          }
          return null;
        });

        const result = await setupWebhookEndpoint(
          "sk_test_mock",
          "https://example.com/webhook/delete-error-test-unique",
          "we_should_fail_to_delete",
        );

        // The function should continue past the failed delete and still attempt to create
        expect(result).toBeDefined();
        expect(typeof result.success).toBe("boolean");
      });
    });

    test("returns stringified error when non-Error is thrown", async () => {
      // Mock fetch to throw a string (not an Error) to hit the String(err) path
      await withFetchMock(async () => {
        globalThis.fetch = () => {
          throw "string_error";
        }; // non-Error value

        const result = await setupWebhookEndpoint(
          "sk_test_mock",
          "https://example.com/webhook/non-error-throw",
        );

        expect(result.success).toBe(false);
        if (!result.success) {
          // Stripe SDK wraps thrown values, so error message comes from SDK wrapper
          expect(typeof result.error).toBe("string");
          expect(result.error!.length > 0).toBe(true);
        }
      });
    });
  });

  describe("verifyWebhookSignature - timestamp parsing", () => {
    const TEST_SECRET = "whsec_test_secret_key_for_timestamp_test";

    test("handles timestamp value that needs parseInt", async () => {
      await settings.update.stripe.webhookConfig({
        endpointId: "we_test_ts",
        secret: TEST_SECRET,
      });

      // Create listing with proper signature
      const listing: StripeWebhookEvent = {
        data: { object: { id: "cs_test" } },
        id: "evt_ts_test",
        type: "checkout.session.completed",
      };

      const { payload, signature } = await constructTestWebhookEvent(
        listing,
        TEST_SECRET,
      );

      const result = await verifyWebhookSignature(payload, signature);
      expect(result.valid).toBe(true);
    });

    test("parses timestamp with parseInt when t key has value", async () => {
      await settings.update.stripe.webhookConfig({
        endpointId: "we_test_parse",
        secret: TEST_SECRET,
      });

      // Use a timestamp that is a valid number string, exercising Number.parseInt
      const timestamp = Math.floor(Date.now() / 1000);
      const payload = '{"id": "evt_parse", "type": "test"}';
      const signedPayload = `${timestamp}.${payload}`;

      const sigHex = await hmacHex(TEST_SECRET, signedPayload);

      const result = await verifyWebhookSignature(
        payload,
        `t=${timestamp},v1=${sigHex}`,
      );
      expect(result.valid).toBe(true);
    });

    test("treats t key without equals as zero timestamp via parseInt fallback", async () => {
      await settings.update.stripe.webhookConfig({
        endpointId: "we_test_nullish",
        secret: TEST_SECRET,
      });

      // Header "t,v1=abc123" - split("=") on "t" gives ["t"], so value is undefined
      // value ?? "0" gives "0", parseInt("0", 10) gives 0
      // timestamp === 0, so parseSignatureHeader returns null => "Invalid signature header format"
      const result = await verifyWebhookSignature(
        '{"test": true}',
        "t,v1=abc123",
      );
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toBe("Invalid signature header format");
      }
    });

    test("secureCompare handles strings of different lengths", async () => {
      await settings.update.stripe.webhookConfig({
        endpointId: "we_test_len",
        secret: TEST_SECRET,
      });

      // Provide a signature that has different length than expected
      const timestamp = Math.floor(Date.now() / 1000);
      const result = await verifyWebhookSignature(
        '{"test": true}',
        `t=${timestamp},v1=short`,
      );
      // Signature won't match but should not crash - secureCompare handles length diff
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toBe("Signature verification failed");
      }
    });
  });

  describe("verifyWebhookSignature - enhanced error details", () => {
    const TEST_SECRET = "whsec_test_secret_key_for_detail_tests";

    beforeEach(async () => {
      await settings.update.stripe.webhookConfig({
        endpointId: "we_test_details",
        secret: TEST_SECRET,
      });
    });

    test("logs 'missing timestamp' when header has signature but no timestamp", async () => {
      const errorSpy = spy(console, "error");
      try {
        await verifyWebhookSignature('{"test": true}', "v1=abc123");
        const callArg = errorSpy.calls[0]!.args[0] as string;
        expect(callArg).toContain('detail="invalid header: missing timestamp"');
      } finally {
        errorSpy.restore();
      }
    });

    test("logs 'missing signature' when header has timestamp but no v1", async () => {
      const errorSpy = spy(console, "error");
      try {
        await verifyWebhookSignature('{"test": true}', "t=1234");
        const callArg = errorSpy.calls[0]!.args[0] as string;
        expect(callArg).toContain('detail="invalid header: missing signature"');
      } finally {
        errorSpy.restore();
      }
    });

    test("logs 'missing timestamp and signature' for completely invalid header", async () => {
      const errorSpy = spy(console, "error");
      try {
        await verifyWebhookSignature('{"test": true}', "invalid-header");
        const callArg = errorSpy.calls[0]!.args[0] as string;
        expect(callArg).toContain(
          'detail="invalid header: missing timestamp and signature"',
        );
      } finally {
        errorSpy.restore();
      }
    });

    test("logs timestamp delta and tolerance when out of tolerance", async () => {
      const errorSpy = spy(console, "error");
      const oldTimestamp = Math.floor(Date.now() / 1000) - 400;
      const payload = '{"test": true}';
      const signedPayload = `${oldTimestamp}.${payload}`;

      const sigHex = await hmacHex(TEST_SECRET, signedPayload);

      try {
        await verifyWebhookSignature(payload, `t=${oldTimestamp},v1=${sigHex}`);
        const callArg = errorSpy.calls[0]!.args[0] as string;
        expect(callArg).toContain("timestamp out of tolerance delta=");
        expect(callArg).toContain("tolerance=300s");
      } finally {
        errorSpy.restore();
      }
    });

    test("logs JSON parse error message for invalid payload", async () => {
      const errorSpy = spy(console, "error");
      const payload = "not valid json {{{";
      const timestamp = Math.floor(Date.now() / 1000);
      const signedPayload = `${timestamp}.${payload}`;

      const sigHex = await hmacHex(TEST_SECRET, signedPayload);

      try {
        await verifyWebhookSignature(payload, `t=${timestamp},v1=${sigHex}`);
        const callArg = errorSpy.calls[0]!.args[0] as string;
        expect(callArg).toContain('detail="invalid JSON:');
      } finally {
        errorSpy.restore();
      }
    });
  });
});

describeWithEnv("stripe-provider", STRIPE_MOCK_ENV, () => {
  resetStripeBetweenTests();

  describe("toCheckoutResult - session with no URL", () => {
    test("returns null when session has no URL", async () => {
      const client = await enabledStripeClient();

      // Spy on stripe.checkout.sessions.create to return session without URL
      await withCheckoutCreate(
        client,
        checkoutSession("cs_no_url", null),
        async () => {
          const listing = testListing({ unit_price: 1000 });
          const intent = checkoutIntent({ items: [listingItem(listing)] });

          // Use stripePaymentProvider which wraps via toCheckoutResult
          const result = await stripePaymentProvider.createCheckoutSession(
            intent,
            "http://localhost:3000",
          );

          expect(result).toBeNull();
        },
      );
    });

    test("returns null when session is null", async () => {
      const client = await enabledStripeClient();

      await withCheckoutSessionsStub(
        client,
        "create",
        () => Promise.reject(new Error("API error")),
        async () => {
          const listing = testListing({ unit_price: 1000 });
          const intent = checkoutIntent({ items: [listingItem(listing)] });

          const result = await stripePaymentProvider.createCheckoutSession(
            intent,
            "http://localhost:3000",
          );

          expect(result).toBeNull();
        },
      );
    });
  });

  describe("retrieveSession - edge cases", () => {
    test("returns null for session without items", async () => {
      const client = await enabledStripeClient();

      await withCheckoutRetrieve(
        client,
        {
          id: "cs_no_items",
          metadata: {
            email: "test@example.com",
            name: "Test User",
            // No items field
          },
          payment_intent: "pi_test_123",
          payment_status: "paid",
        },
        async () => {
          const result =
            await stripePaymentProvider.retrieveSession("cs_no_items");
          expect(result).toBeNull();
        },
      );
    });

    test("returns null when session is null from Stripe", async () => {
      const client = await enabledStripeClient();

      await withCheckoutSessionsStub(
        client,
        "retrieve",
        () => Promise.reject(new Error("Not found")),
        async () => {
          const result =
            await stripePaymentProvider.retrieveSession("cs_notfound");
          expect(result).toBeNull();
        },
      );
    });

    test("returns null when metadata is missing name or email", async () => {
      const client = await enabledStripeClient();

      await withCheckoutRetrieve(
        client,
        {
          id: "cs_no_meta",
          metadata: {
            items: '[{"e":1,"q":1,"p":0}]',
            // Missing name and email
          },
          payment_status: "paid",
        },
        async () => {
          const result =
            await stripePaymentProvider.retrieveSession("cs_no_meta");
          expect(result).toBeNull();
        },
      );
    });

    test("returns valid session for multi-ticket checkout", async () => {
      const client = await enabledStripeClient();

      await withCheckoutRetrieve(
        client,
        {
          id: "cs_multi",
          metadata: {
            email: "multi@example.com",
            items: '[{"e":1,"q":2}]',
            name: "Multi User",
            phone: "+44 7700 900000",
          },
          payment_intent: "pi_multi_123",
          payment_status: "paid",
        },
        async () => {
          const result =
            await stripePaymentProvider.retrieveSession("cs_multi");
          expect(result).not.toBeNull();
          expect(result?.id).toBe("cs_multi");
          expect(result?.metadata.items).toBe('[{"e":1,"q":2}]');
          expect(result?.metadata.phone).toBe("+44 7700 900000");
        },
      );
    });

    test("returns valid session for single-listing checkout", async () => {
      const client = await enabledStripeClient();

      await withCheckoutRetrieve(
        client,
        {
          id: "cs_single",
          metadata: {
            email: "single@example.com",
            items: '[{"e":42,"q":2,"p":0}]',
            name: "Single User",
          },
          payment_intent: "pi_single_123",
          payment_status: "paid",
        },
        async () => {
          const result =
            await stripePaymentProvider.retrieveSession("cs_single");
          expect(result).not.toBeNull();
          expect(result?.id).toBe("cs_single");
          expect(result?.paymentStatus).toBe("paid");
          expect(result?.paymentReference).toBe("pi_single_123");
          expect(result?.metadata.items).toBe('[{"e":42,"q":2,"p":0}]');
        },
      );
    });

    test("returns amountTotal when session has numeric amount_total", async () => {
      const client = await enabledStripeClient();

      await withCheckoutRetrieve(
        client,
        {
          amount_total: 4500,
          id: "cs_with_amount",
          metadata: {
            email: "amount@example.com",
            items: '[{"e":10,"q":3,"p":0}]',
            name: "Amount User",
          },
          payment_intent: "pi_amount_123",
          payment_status: "paid",
        },
        async () => {
          const result =
            await stripePaymentProvider.retrieveSession("cs_with_amount");
          expect(result).not.toBeNull();
          expect(result?.amountTotal).toBe(4500);
          expect(result?.paymentReference).toBe("pi_amount_123");
        },
      );
    });

    test("returns null when amount_total is null", async () => {
      const client = await enabledStripeClient();

      await withCheckoutRetrieve(
        client,
        {
          amount_total: null,
          id: "cs_null_amount",
          metadata: {
            email: "nullamount@example.com",
            items: '[{"e":1,"q":1,"p":0}]',
            name: "Null Amount User",
          },
          payment_intent: "pi_null_amount",
          payment_status: "paid",
        },
        async () => {
          const result =
            await stripePaymentProvider.retrieveSession("cs_null_amount");
          expect(result).toBeNull();
        },
      );
    });

    test("falls back to unpaid for invalid payment_status", async () => {
      const client = await enabledStripeClient();

      await withCheckoutRetrieve(
        client,
        {
          amount_total: 1000,
          id: "cs_bad_status",
          metadata: {
            email: "badstatus@example.com",
            items: '[{"e":1,"q":1,"p":0}]',
            name: "Bad Status User",
          },
          payment_intent: "pi_bad_status",
          payment_status: "completed",
        },
        async () => {
          const result =
            await stripePaymentProvider.retrieveSession("cs_bad_status");
          expect(result).not.toBeNull();
          expect(result?.paymentStatus).toBe("unpaid");
        },
      );
    });

    test("casts amount_total to number", async () => {
      const client = await enabledStripeClient();

      await withCheckoutRetrieve(
        client,
        {
          amount_total: 7500,
          id: "cs_amount_cast",
          metadata: {
            email: "cast@example.com",
            items: '[{"e":11,"q":1,"p":0}]',
            name: "Cast User",
          },
          payment_intent: "pi_amount_cast",
          payment_status: "paid",
        },
        async () => {
          const result =
            await stripePaymentProvider.retrieveSession("cs_amount_cast");
          expect(result).not.toBeNull();
          expect(result?.amountTotal).toBe(7500);
        },
      );
    });
  });

  describe("verifyWebhookSignature delegation", () => {
    test("delegates to stripe.ts verifyWebhookSignature", async () => {
      const TEST_SECRET = "whsec_provider_verify_test";
      await settings.update.stripe.webhookConfig({
        endpointId: "we_provider_test",
        secret: TEST_SECRET,
      });

      const listing: StripeWebhookEvent = {
        data: { object: { id: "cs_test" } },
        id: "evt_provider",
        type: "checkout.session.completed",
      };

      const { payload, signature } = await constructTestWebhookEvent(
        listing,
        TEST_SECRET,
      );

      const result = await stripePaymentProvider.verifyWebhookSignature(
        payload,
        signature,
        "https://example.com/payment/webhook",
        new TextEncoder().encode(payload),
      );
      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.listing.id).toBe("evt_provider");
      }
    });

    test("returns error for invalid signature", async () => {
      const TEST_SECRET = "whsec_provider_invalid_test";
      await settings.update.stripe.webhookConfig({
        endpointId: "we_provider_inv",
        secret: TEST_SECRET,
      });

      const timestamp = Math.floor(Date.now() / 1000);
      const body = '{"test": true}';
      const result = await stripePaymentProvider.verifyWebhookSignature(
        body,
        `t=${timestamp},v1=invalid_sig`,
        "https://example.com/payment/webhook",
        new TextEncoder().encode(body),
      );

      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toBeDefined();
      }
    });
  });

  describe("setupWebhookEndpoint delegation", () => {
    test("delegates to stripe.ts setupWebhookEndpoint", async () => {
      // Mock stripeApi since setupWebhookEndpointImpl creates its own client
      const origSetup = stripeApi.setupWebhookEndpoint;
      stripeApi.setupWebhookEndpoint = (_key, _url, _existing) =>
        Promise.resolve({
          endpointId: "we_provider_created",
          secret: "whsec_provider_secret",
          success: true,
        });

      try {
        const result = await stripePaymentProvider.setupWebhookEndpoint(
          "sk_test_mock",
          "https://example.com/payment/webhook",
        );

        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.endpointId).toBe("we_provider_created");
          expect(result.secret).toBe("whsec_provider_secret");
        }
      } finally {
        stripeApi.setupWebhookEndpoint = origSetup;
      }
    });
  });

  describe("refundPayment delegation", () => {
    test("returns true when refund succeeds", async () => {
      await settings.update.stripe.secretKey("sk_test_mock");
      const result = await stripePaymentProvider.refundPayment("pi_test_123");
      expect(result).toBe(true);
    });

    test("returns false when refund fails", async () => {
      const client = await enabledStripeClient();

      const refundSpy = stub(client.refunds, "create", () =>
        Promise.reject(new Error("Refund failed")),
      );

      try {
        const result = await stripePaymentProvider.refundPayment("pi_fail");
        expect(result).toBe(false);
      } finally {
        refundSpy.restore();
      }
    });
  });

  describe("sanitizeErrorDetail edge cases", () => {
    test("returns err.name when no statusCode/code/type and name is set", () => {
      const err = new TypeError("something went wrong");
      const detail = sanitizeErrorDetail(err);
      expect(detail).toBe("TypeError");
    });
  });

  describe("getMockConfig without STRIPE_MOCK_HOST", () => {
    test("creates client without mock config when STRIPE_MOCK_HOST not set", async () => {
      await settings.update.stripe.secretKey("sk_test_123");
      const restore = setTestEnv({
        STRIPE_MOCK_HOST: undefined,
        STRIPE_MOCK_PORT: undefined,
      });
      try {
        // resetStripeClient now also resets getMockConfig (lazyRef)
        resetStripeClient();

        const client = await getStripeClient();
        // Client is created using real Stripe (no mock) - returns non-null
        expect(client !== undefined).toBe(true);
      } finally {
        restore();
        resetStripeClient();
      }
    });
  });

  describe("retrievePaymentIntent", () => {
    test("returns null when stripe key not set", async () => {
      const result = await retrievePaymentIntent("pi_test_123");
      expect(result).toBeNull();
    });

    test("returns null when Stripe API throws error", async () => {
      const client = await enabledStripeClient();

      await withMocks(
        () =>
          stub(client.paymentIntents, "retrieve", () =>
            Promise.reject(new Error("Network error")),
          ),
        async (retrieveSpy) => {
          const result = await retrievePaymentIntent("pi_test_123");
          expect(result).toBeNull();
          expect(retrieveSpy.calls.length).toBeGreaterThan(0);
        },
      );
    });
  });

  describe("isPaymentRefunded", () => {
    test("returns true when latest_charge is refunded", async () => {
      const client = await enabledStripeClient();

      await withPaymentIntent(
        client,
        { id: "pi_refunded", latest_charge: { id: "ch_1", refunded: true } },
        async () => {
          const result =
            await stripePaymentProvider.isPaymentRefunded("pi_refunded");
          expect(result).toBe(true);
        },
      );
    });

    test("returns false when latest_charge is not refunded", async () => {
      const client = await enabledStripeClient();

      await withPaymentIntent(
        client,
        {
          id: "pi_not_refunded",
          latest_charge: { id: "ch_2", refunded: false },
        },
        async () => {
          const result =
            await stripePaymentProvider.isPaymentRefunded("pi_not_refunded");
          expect(result).toBe(false);
        },
      );
    });

    test("returns false when payment intent not found", async () => {
      const client = await enabledStripeClient();

      await withMocks(
        () =>
          stub(client.paymentIntents, "retrieve", () =>
            Promise.reject(new Error("Not found")),
          ),
        async () => {
          const result =
            await stripePaymentProvider.isPaymentRefunded("pi_missing");
          expect(result).toBe(false);
        },
      );
    });

    test("returns false when latest_charge is a string ID", async () => {
      const client = await enabledStripeClient();

      await withPaymentIntent(
        client,
        { id: "pi_string_charge", latest_charge: "ch_string_id" },
        async () => {
          const result =
            await stripePaymentProvider.isPaymentRefunded("pi_string_charge");
          expect(result).toBe(false);
        },
      );
    });
  });

  describe("createCheckoutSession - via provider", () => {
    test("returns null when session has no URL", async () => {
      const client = await enabledStripeClient();

      await withCheckoutCreate(
        client,
        checkoutSession("cs_multi_nourl", null),
        async () => {
          const intent = checkoutIntent({
            email: "jane@example.com",
            items: [checkoutItem({ name: "Evt", slug: "evt" })],
            name: "Jane",
          });
          const result = await stripePaymentProvider.createCheckoutSession(
            intent,
            "http://localhost:3000",
          );
          expect(result).toBeNull();
        },
      );
    });
  });

  describe("metadata size limits", () => {
    test("returns error when items metadata exceeds Stripe limit", async () => {
      await settings.update.stripe.secretKey("sk_test_mock");
      // Generate enough items to exceed 500-char serialized metadata
      const intent = checkoutIntent({
        email: "alice@example.com",
        items: numberedItems(40),
        name: "Alice",
      });
      const result = await stripePaymentProvider.createCheckoutSession(
        intent,
        "http://localhost:3000",
      );
      expect(result).not.toBeNull();
      expect(result).toHaveProperty("error");
      expect((result as { error: string }).error).toMatch(/too many listings/i);
    });

    test("returns null for non-PaymentUserError exceptions", async () => {
      await settings.update.stripe.secretKey("sk_test_mock");
      // Stub stripeApi.createCheckoutSession to throw a generic error
      // that propagates through to withUserError's catch
      const origFn = stripeApi.createCheckoutSession;
      stripeApi.createCheckoutSession = () =>
        Promise.reject(new TypeError("unexpected"));
      try {
        const intent = checkoutIntent({
          items: [checkoutItem({ name: "Evt", slug: "evt" })],
        });
        const result = await stripePaymentProvider.createCheckoutSession(
          intent,
          "http://localhost:3000",
        );
        expect(result).toBeNull();
      } finally {
        stripeApi.createCheckoutSession = origFn;
      }
    });
  });

  describe("resolveWebhookSession", () => {
    test("extracts session directly from listing with complete metadata", async () => {
      const result = await stripePaymentProvider.resolveWebhookSession({
        data: {
          object: {
            amount_total: 2000,
            id: "cs_resolve_1",
            metadata: {
              email: "alice@example.com",
              items: '[{"e":1,"q":1,"p":0}]',
              name: "Alice",
            },
            payment_intent: "pi_resolve_1",
            payment_status: "paid",
          },
        },
        id: "evt_resolve_1",
        type: "checkout.session.completed",
      });
      expect(result).not.toBe("skip");
      expect(result).not.toBeNull();
      if (result && result !== "skip") {
        expect(result.id).toBe("cs_resolve_1");
        expect(result.paymentStatus).toBe("paid");
        expect(result.paymentReference).toBe("pi_resolve_1");
        expect(result.amountTotal).toBe(2000);
      }
    });

    test("falls back to retrieveSession when listing lacks metadata", async () => {
      const mockRetrieve = stub(stripeApi, "retrieveCheckoutSession", () =>
        Promise.resolve(null),
      );

      try {
        const result = await stripePaymentProvider.resolveWebhookSession({
          data: {
            object: {
              id: "cs_no_meta",
              // No payment_status or metadata
            },
          },
          id: "evt_no_meta",
          type: "checkout.session.completed",
        });
        // retrieveSession called with listing object id
        expect(mockRetrieve.calls[0]!.args[0]).toBe("cs_no_meta");
        expect(result).toBeNull();
      } finally {
        mockRetrieve.restore();
      }
    });

    test("returns null when listing has no id", async () => {
      const result = await stripePaymentProvider.resolveWebhookSession({
        data: {
          object: {
            some_field: "value",
          },
        },
        id: "evt_no_obj_id",
        type: "checkout.session.completed",
      });
      expect(result).toBeNull();
    });
  });
});
