import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  createCheckoutSession,
  formatPrice,
  getStripeClient,
  resetStripeClient,
  retrieveCheckoutSession,
  verifyWebhookSignature,
} from "#lib/stripe.ts";

describe("stripe", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    resetStripeClient();
    // Clear Stripe-related env vars for unit tests
    // stripe-mock config is set in test/setup.ts
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.CURRENCY_CODE;
  });

  afterEach(() => {
    resetStripeClient();
    process.env = { ...originalEnv };
  });

  describe("getStripeClient", () => {
    test("returns null when STRIPE_SECRET_KEY not set", () => {
      const client = getStripeClient();
      expect(client).toBeNull();
    });

    test("returns client when STRIPE_SECRET_KEY is set", () => {
      process.env.STRIPE_SECRET_KEY = "sk_test_123";
      const client = getStripeClient();
      expect(client).not.toBeNull();
    });

    test("returns same client on subsequent calls", () => {
      process.env.STRIPE_SECRET_KEY = "sk_test_123";
      const client1 = getStripeClient();
      const client2 = getStripeClient();
      expect(client1).toBe(client2);
    });
  });

  describe("resetStripeClient", () => {
    test("resets client to null", () => {
      process.env.STRIPE_SECRET_KEY = "sk_test_123";
      const client1 = getStripeClient();
      expect(client1).not.toBeNull();

      resetStripeClient();
      delete process.env.STRIPE_SECRET_KEY;

      const client2 = getStripeClient();
      expect(client2).toBeNull();
    });
  });

  describe("formatPrice", () => {
    test("formats price in GBP by default", () => {
      const formatted = formatPrice(1000);
      expect(formatted).toContain("10");
    });

    test("formats price in specified currency", () => {
      process.env.CURRENCY_CODE = "USD";
      const formatted = formatPrice(2500);
      expect(formatted).toContain("25");
    });

    test("formats zero price", () => {
      const formatted = formatPrice(0);
      expect(formatted).toContain("0");
    });

    test("formats small amounts correctly", () => {
      const formatted = formatPrice(99);
      expect(formatted).toContain("0.99");
    });
  });

  describe("verifyWebhookSignature", () => {
    test("returns null when STRIPE_SECRET_KEY not set", () => {
      const result = verifyWebhookSignature("payload", "sig", "secret");
      expect(result).toBeNull();
    });

    test("returns null for invalid signature", () => {
      process.env.STRIPE_SECRET_KEY = "sk_test_123";
      const result = verifyWebhookSignature(
        "invalid_payload",
        "invalid_signature",
        "whsec_test",
      );
      expect(result).toBeNull();
    });
  });

  describe("retrieveCheckoutSession", () => {
    test("returns null when STRIPE_SECRET_KEY not set", async () => {
      const result = await retrieveCheckoutSession("cs_test_123");
      expect(result).toBeNull();
    });

    test("returns null for invalid session when key set but no mock", async () => {
      process.env.STRIPE_SECRET_KEY = "sk_test_123";
      const result = await retrieveCheckoutSession("cs_invalid");
      // Returns null because Stripe API call fails
      expect(result).toBeNull();
    });
  });

  describe("createCheckoutSession", () => {
    test("returns null when STRIPE_SECRET_KEY not set", async () => {
      const event = {
        id: 1,
        name: "Test",
        description: "Desc",
        created: new Date().toISOString(),
        max_attendees: 50,
        thank_you_url: "https://example.com",
        unit_price: 1000,
      };
      const attendee = {
        id: 1,
        event_id: 1,
        name: "John",
        email: "john@example.com",
        created: new Date().toISOString(),
        stripe_payment_id: null,
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
        name: "Test",
        description: "Desc",
        created: new Date().toISOString(),
        max_attendees: 50,
        thank_you_url: "https://example.com",
        unit_price: null,
      };
      const attendee = {
        id: 1,
        event_id: 1,
        name: "John",
        email: "john@example.com",
        created: new Date().toISOString(),
        stripe_payment_id: null,
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
    test("creates client with mock config when STRIPE_MOCK_HOST is set", () => {
      // This test exercises the getMockConfig code path
      process.env.STRIPE_SECRET_KEY = "sk_test_123";
      process.env.STRIPE_MOCK_HOST = "localhost";
      process.env.STRIPE_MOCK_PORT = "12111";

      // This will create a client with mock config, but won't make any API calls
      const client = getStripeClient();
      expect(client).not.toBeNull();
    });

    test("uses default port 12111 when STRIPE_MOCK_PORT not set", () => {
      process.env.STRIPE_SECRET_KEY = "sk_test_123";
      process.env.STRIPE_MOCK_HOST = "localhost";
      // STRIPE_MOCK_PORT not set, should default to 12111

      const client = getStripeClient();
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
        name: "Test Event",
        description: "Test Description",
        created: new Date().toISOString(),
        max_attendees: 50,
        thank_you_url: "https://example.com/thanks",
        unit_price: 1000,
      };
      const attendee = {
        id: 1,
        event_id: 1,
        name: "John Doe",
        email: "john@example.com",
        created: new Date().toISOString(),
        stripe_payment_id: null,
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
        name: "Test Event",
        description: "Test Description",
        created: new Date().toISOString(),
        max_attendees: 50,
        thank_you_url: "https://example.com/thanks",
        unit_price: 1000,
      };
      const attendee = {
        id: 1,
        event_id: 1,
        name: "John Doe",
        email: "john@example.com",
        created: new Date().toISOString(),
        stripe_payment_id: null,
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
  });
});
