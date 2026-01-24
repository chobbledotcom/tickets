import { afterEach, beforeEach, describe, expect, test, spyOn } from "#test-compat";
import {
  constructTestWebhookEvent,
  createCheckoutSessionWithIntent,
  getStripeClient,
  refundPayment,
  resetStripeClient,
  retrieveCheckoutSession,
  type StripeWebhookEvent,
  verifyWebhookSignature,
} from "#lib/stripe.ts";
import { createCheckoutSession, createTestDb, resetDb } from "#test-utils";
import process from "node:process";

describe("stripe", () => {
  let originalMockHost: string | undefined;
  let originalMockPort: string | undefined;

  beforeEach(async () => {
    originalMockHost = Deno.env.get("STRIPE_MOCK_HOST");
    originalMockPort = Deno.env.get("STRIPE_MOCK_PORT");
    resetStripeClient();
    // Create in-memory db for testing
    await createTestDb();
    // Clear Stripe key by default
    delete process.env.STRIPE_SECRET_KEY;
  });

  afterEach(() => {
    resetStripeClient();
    resetDb();
    // Restore original env values
    if (originalMockHost !== undefined) {
      Deno.env.set("STRIPE_MOCK_HOST", originalMockHost);
    } else {
      Deno.env.delete("STRIPE_MOCK_HOST");
    }
    if (originalMockPort !== undefined) {
      Deno.env.set("STRIPE_MOCK_PORT", originalMockPort);
    } else {
      Deno.env.delete("STRIPE_MOCK_PORT");
    }
  });

  describe("getStripeClient", () => {
    test("returns null when stripe key not set", async () => {
      const client = await getStripeClient();
      expect(client).toBeNull();
    });

    test("returns client when stripe key is set in environment", async () => {
      process.env.STRIPE_SECRET_KEY = "sk_test_123";
      const client = await getStripeClient();
      expect(client).not.toBeNull();
    });

    test("returns same client on subsequent calls", async () => {
      process.env.STRIPE_SECRET_KEY = "sk_test_123";
      const client1 = await getStripeClient();
      const client2 = await getStripeClient();
      expect(client1).toBe(client2);
    });
  });

  describe("resetStripeClient", () => {
    test("resets client to null", async () => {
      process.env.STRIPE_SECRET_KEY = "sk_test_123";
      const client1 = await getStripeClient();
      expect(client1).not.toBeNull();

      resetStripeClient();
      // Clear the environment variable too
      delete process.env.STRIPE_SECRET_KEY;

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
      // spyOn already imported from #test-compat

      // Enable Stripe with mock
      process.env.STRIPE_SECRET_KEY = "sk_test_mock";
      const client = await getStripeClient();
      if (!client) throw new Error("Expected client to be defined");

      // Spy on the checkout.sessions.retrieve method and make it throw
      const retrieveSpy = spyOn(
        client.checkout.sessions,
        "retrieve",
      ).mockRejectedValue(new Error("Network error"));

      try {
        const result = await retrieveCheckoutSession("cs_test_123");
        expect(result).toBeNull();
        expect(retrieveSpy).toHaveBeenCalledWith("cs_test_123");
      } finally {
        retrieveSpy.mockRestore?.();
      }
    });
  });

  describe("createCheckoutSession", () => {
    test("returns null when stripe key not set", async () => {
      const event = {
        id: 1,
        slug: "test-event",
        name: "Test",
        description: "Desc",
        created: new Date().toISOString(),
        max_attendees: 50,
        thank_you_url: "https://example.com",
        unit_price: 1000,
        max_quantity: 1,
        webhook_url: null,
        active: 1,
      };
      const attendee = {
        id: 1,
        event_id: 1,
        name: "John",
        email: "john@example.com",
        created: new Date().toISOString(),
        stripe_payment_id: null,
        quantity: 1,
      };
      const result = await createCheckoutSession(
        event,
        attendee,
        "http://localhost",
      );
      expect(result).toBeNull();
    });

    test("returns null when unit_price is null", async () => {
      process.env.STRIPE_SECRET_KEY = "sk_test_123";
      const event = {
        id: 1,
        slug: "test-event",
        name: "Test",
        description: "Desc",
        created: new Date().toISOString(),
        max_attendees: 50,
        thank_you_url: "https://example.com",
        unit_price: null,
        max_quantity: 1,
        webhook_url: null,
        active: 1,
      };
      const attendee = {
        id: 1,
        event_id: 1,
        name: "John",
        email: "john@example.com",
        created: new Date().toISOString(),
        stripe_payment_id: null,
        quantity: 1,
      };
      const result = await createCheckoutSession(
        event,
        attendee,
        "http://localhost",
      );
      expect(result).toBeNull();
    });
  });

  describe("mock configuration", () => {
    test("creates client with mock config when STRIPE_MOCK_HOST is set", async () => {
      // This test exercises the getMockConfig code path
      process.env.STRIPE_SECRET_KEY = "sk_test_123";
      process.env.STRIPE_MOCK_HOST = "localhost";
      process.env.STRIPE_MOCK_PORT = "12111";

      // This will create a client with mock config, but won't make any API calls
      const client = await getStripeClient();
      expect(client).not.toBeNull();
    });

    test("uses default port 12111 when STRIPE_MOCK_PORT not set", async () => {
      process.env.STRIPE_SECRET_KEY = "sk_test_123";
      process.env.STRIPE_MOCK_HOST = "localhost";
      delete process.env.STRIPE_MOCK_PORT;

      const client = await getStripeClient();
      expect(client).not.toBeNull();
    });
  });

  describe("stripe-mock integration", () => {
    // These tests require stripe-mock running on localhost:12111
    // STRIPE_MOCK_HOST/PORT are set in test/setup.ts

    test("creates checkout session with stripe-mock", async () => {
      process.env.STRIPE_SECRET_KEY = "sk_test_mock";

      const event = {
        id: 1,
        slug: "test-event",
        name: "Test Event",
        description: "Test Description",
        created: new Date().toISOString(),
        max_attendees: 50,
        thank_you_url: "https://example.com/thanks",
        unit_price: 1000,
        max_quantity: 1,
        webhook_url: null,
        active: 1,
      };
      const attendee = {
        id: 1,
        event_id: 1,
        name: "John Doe",
        email: "john@example.com",
        created: new Date().toISOString(),
        stripe_payment_id: null,
        quantity: 1,
      };

      const session = await createCheckoutSession(
        event,
        attendee,
        "http://localhost:3000",
      );

      expect(session).not.toBeNull();
      expect(session?.id).toBeDefined();
      expect(session?.url).toBeDefined();
    });

    test("retrieves checkout session with stripe-mock", async () => {
      process.env.STRIPE_SECRET_KEY = "sk_test_mock";

      // First create a session
      const event = {
        id: 1,
        slug: "test-event",
        name: "Test Event",
        description: "Test Description",
        created: new Date().toISOString(),
        max_attendees: 50,
        thank_you_url: "https://example.com/thanks",
        unit_price: 1000,
        max_quantity: 1,
        webhook_url: null,
        active: 1,
      };
      const attendee = {
        id: 1,
        event_id: 1,
        name: "John Doe",
        email: "john@example.com",
        created: new Date().toISOString(),
        stripe_payment_id: null,
        quantity: 1,
      };

      const createdSession = await createCheckoutSession(
        event,
        attendee,
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
      process.env.STRIPE_SECRET_KEY = "sk_test_mock";

      const event = {
        id: 1,
        slug: "test-event",
        name: "Test Event",
        description: "Test Description",
        created: new Date().toISOString(),
        max_attendees: 50,
        thank_you_url: "https://example.com/thanks",
        unit_price: 1000,
        max_quantity: 5,
        webhook_url: null,
        active: 1,
      };

      const intent = {
        eventId: 1,
        name: "John Doe",
        email: "john@example.com",
        quantity: 2,
      };

      const session = await createCheckoutSessionWithIntent(
        event,
        intent,
        "http://localhost:3000",
      );

      // stripe-mock creates session successfully but may not return our custom metadata
      expect(session).not.toBeNull();
      expect(session?.id).toBeDefined();
      expect(session?.url).toBeDefined();
    });

    test("refunds payment with stripe-mock", async () => {
      process.env.STRIPE_SECRET_KEY = "sk_test_mock";

      // stripe-mock accepts any payment_intent ID
      const refund = await refundPayment("pi_test_123");

      expect(refund).not.toBeNull();
      expect(refund?.id).toBeDefined();
    });
  });

  describe("createCheckoutSessionWithIntent", () => {
    test("returns null when stripe key not set", async () => {
      const event = {
        id: 1,
        slug: "test-event",
        name: "Test",
        description: "Desc",
        created: new Date().toISOString(),
        max_attendees: 50,
        thank_you_url: "https://example.com",
        unit_price: 1000,
        max_quantity: 1,
        webhook_url: null,
        active: 1,
      };
      const intent = {
        eventId: 1,
        name: "John",
        email: "john@example.com",
        quantity: 1,
      };
      const result = await createCheckoutSessionWithIntent(
        event,
        intent,
        "http://localhost",
      );
      expect(result).toBeNull();
    });

    test("returns null when unit_price is null", async () => {
      process.env.STRIPE_SECRET_KEY = "sk_test_123";
      const event = {
        id: 1,
        slug: "test-event",
        name: "Test",
        description: "Desc",
        created: new Date().toISOString(),
        max_attendees: 50,
        thank_you_url: "https://example.com",
        unit_price: null,
        max_quantity: 1,
        webhook_url: null,
        active: 1,
      };
      const intent = {
        eventId: 1,
        name: "John",
        email: "john@example.com",
        quantity: 1,
      };
      const result = await createCheckoutSessionWithIntent(
        event,
        intent,
        "http://localhost",
      );
      expect(result).toBeNull();
    });
  });

  describe("refundPayment", () => {
    test("returns null when stripe key not set", async () => {
      const result = await refundPayment("pi_test_123");
      expect(result).toBeNull();
    });

    test("returns null when Stripe API throws error", async () => {
      const { spyOn } = await import("#test-compat");

      process.env.STRIPE_SECRET_KEY = "sk_test_mock";
      const client = await getStripeClient();
      if (!client) throw new Error("Expected client to be defined");

      const refundSpy = spyOn(client.refunds, "create");
      refundSpy.mockRejectedValue(new Error("Network error"));

      try {
        const result = await refundPayment("pi_test_123");
        expect(result).toBeNull();
        expect(refundSpy).toHaveBeenCalled();
      } finally {
        refundSpy.mockRestore();
      }
    });
  });

  describe("verifyWebhookSignature", () => {
    const TEST_SECRET = "whsec_test_secret_key_for_webhook_verification";
    let originalWebhookSecret: string | undefined;

    beforeEach(() => {
      originalWebhookSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET");
      Deno.env.set("STRIPE_WEBHOOK_SECRET", TEST_SECRET);
    });

    afterEach(() => {
      if (originalWebhookSecret !== undefined) {
        Deno.env.set("STRIPE_WEBHOOK_SECRET", originalWebhookSecret);
      } else {
        Deno.env.delete("STRIPE_WEBHOOK_SECRET");
      }
    });

    test("returns error when webhook secret not configured", async () => {
      Deno.env.delete("STRIPE_WEBHOOK_SECRET");
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
      const result = await verifyWebhookSignature(
        '{"test": true}',
        "t=1234",
      );
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
      const encoder = new TextEncoder();
      const key = await crypto.subtle.importKey(
        "raw",
        encoder.encode(TEST_SECRET),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );
      const signature = await crypto.subtle.sign(
        "HMAC",
        key,
        encoder.encode(signedPayload),
      );
      const sigHex = Array.from(new Uint8Array(signature))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");

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
      const encoder = new TextEncoder();
      const key = await crypto.subtle.importKey(
        "raw",
        encoder.encode(TEST_SECRET),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );
      const signature = await crypto.subtle.sign(
        "HMAC",
        key,
        encoder.encode(signedPayload),
      );
      const sigHex = Array.from(new Uint8Array(signature))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");

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
      const event: StripeWebhookEvent = {
        id: "evt_test_123",
        type: "checkout.session.completed",
        data: {
          object: {
            id: "cs_test_123",
            payment_status: "paid",
            metadata: {
              event_id: "1",
              name: "John Doe",
              email: "john@example.com",
              quantity: "1",
            },
          },
        },
      };

      const { payload, signature } = await constructTestWebhookEvent(
        event,
        TEST_SECRET,
      );

      const result = await verifyWebhookSignature(payload, signature);
      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.event.id).toBe("evt_test_123");
        expect(result.event.type).toBe("checkout.session.completed");
      }
    });

    test("accepts custom tolerance window", async () => {
      // Create signature with timestamp 100 seconds ago
      const oldTimestamp = Math.floor(Date.now() / 1000) - 100;
      const payload = '{"id": "evt_123", "type": "test"}';
      const signedPayload = `${oldTimestamp}.${payload}`;

      const encoder = new TextEncoder();
      const key = await crypto.subtle.importKey(
        "raw",
        encoder.encode(TEST_SECRET),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );
      const signature = await crypto.subtle.sign(
        "HMAC",
        key,
        encoder.encode(signedPayload),
      );
      const sigHex = Array.from(new Uint8Array(signature))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");

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

  describe("constructTestWebhookEvent", () => {
    test("creates valid payload and signature pair", async () => {
      const secret = "whsec_test_construction";
      const event: StripeWebhookEvent = {
        id: "evt_constructed",
        type: "payment_intent.succeeded",
        data: {
          object: {
            amount: 1000,
            currency: "gbp",
          },
        },
      };

      const { payload, signature } = await constructTestWebhookEvent(
        event,
        secret,
      );

      // Verify payload is valid JSON matching input
      const parsed = JSON.parse(payload);
      expect(parsed.id).toBe("evt_constructed");
      expect(parsed.type).toBe("payment_intent.succeeded");

      // Verify signature format
      expect(signature).toMatch(/^t=\d+,v1=[a-f0-9]+$/);

      // Signature should be verifiable with the same secret
      Deno.env.set("STRIPE_WEBHOOK_SECRET", secret);
      const result = await verifyWebhookSignature(payload, signature);
      expect(result.valid).toBe(true);
    });
  });
});
