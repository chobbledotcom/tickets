import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { encrypt } from "#lib/crypto.ts";
import { setSetting } from "#lib/db/settings";
import {
  createCheckoutSession,
  getStripeClient,
  resetStripeClient,
  retrieveCheckoutSession,
} from "#lib/stripe.ts";
import { createTestDb, resetDb } from "#test-utils";

describe("stripe", () => {
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    resetStripeClient();
    // Create in-memory db for testing
    await createTestDb();
  });

  afterEach(() => {
    resetStripeClient();
    resetDb();
    process.env = { ...originalEnv };
  });

  describe("getStripeClient", () => {
    test("returns null when stripe key not set", async () => {
      const client = await getStripeClient();
      expect(client).toBeNull();
    });

    test("returns client when stripe key is set in database", async () => {
      await setSetting("stripe_key", await encrypt("sk_test_123"));
      const client = await getStripeClient();
      expect(client).not.toBeNull();
    });

    test("returns same client on subsequent calls", async () => {
      await setSetting("stripe_key", await encrypt("sk_test_123"));
      const client1 = await getStripeClient();
      const client2 = await getStripeClient();
      expect(client1).toBe(client2);
    });
  });

  describe("resetStripeClient", () => {
    test("resets client to null", async () => {
      await setSetting("stripe_key", await encrypt("sk_test_123"));
      const client1 = await getStripeClient();
      expect(client1).not.toBeNull();

      resetStripeClient();
      // Clear the database setting too
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
      const { spyOn } = await import("bun:test");

      // Enable Stripe with mock
      await setSetting("stripe_key", await encrypt("sk_test_mock"));
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
        retrieveSpy.mockRestore();
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
      await setSetting("stripe_key", await encrypt("sk_test_123"));
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
      await setSetting("stripe_key", await encrypt("sk_test_123"));
      process.env.STRIPE_MOCK_HOST = "localhost";
      process.env.STRIPE_MOCK_PORT = "12111";

      // This will create a client with mock config, but won't make any API calls
      const client = await getStripeClient();
      expect(client).not.toBeNull();
    });

    test("uses default port 12111 when STRIPE_MOCK_PORT not set", async () => {
      await setSetting("stripe_key", await encrypt("sk_test_123"));
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
      await setSetting("stripe_key", await encrypt("sk_test_mock"));

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
      await setSetting("stripe_key", await encrypt("sk_test_mock"));

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
  });
});
