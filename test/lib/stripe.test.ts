import { afterEach, beforeEach, describe, expect, test, spyOn } from "#test-compat";
import {
  createCheckoutSessionWithIntent,
  getStripeClient,
  refundPayment,
  resetStripeClient,
  retrieveCheckoutSession,
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
});
