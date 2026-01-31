import { afterEach, beforeEach, describe, expect, test, spyOn } from "#test-compat";
import {
  constructTestWebhookEvent,
  getSquareClient,
  resetSquareClient,
  squareApi,
  verifyWebhookSignature,
} from "#lib/square.ts";
import type { WebhookEvent } from "#lib/payments.ts";
import {
  updateSquareAccessToken,
  updateSquareLocationId,
  updateSquareWebhookSignatureKey,
} from "#lib/db/settings.ts";
import { createTestDb, resetDb } from "#test-utils";

describe("square", () => {
  beforeEach(async () => {
    resetSquareClient();
    await createTestDb();
  });

  afterEach(() => {
    resetSquareClient();
    resetDb();
  });

  describe("getSquareClient", () => {
    test("returns null when access token not set", async () => {
      const client = await getSquareClient();
      expect(client).toBeNull();
    });

    test("returns client when access token is set in database", async () => {
      await updateSquareAccessToken("EAAAl_test_123");
      const client = await getSquareClient();
      expect(client).not.toBeNull();
    });
  });

  describe("resetSquareClient", () => {
    test("resets client state after token removed from db", async () => {
      await updateSquareAccessToken("EAAAl_test_123");
      const client1 = await getSquareClient();
      expect(client1).not.toBeNull();

      resetSquareClient();
      resetDb();
      await createTestDb();

      const client2 = await getSquareClient();
      expect(client2).toBeNull();
    });
  });

  describe("createPaymentLink", () => {
    test("returns null when access token not set", async () => {
      const event = {
        id: 1,
        slug: "test-event",
        slug_index: "test-event-index",
        name: "Test Event",
        description: "Test Description",
        created: new Date().toISOString(),
        max_attendees: 50,
        thank_you_url: "https://example.com/thanks",
        unit_price: 1000,
        max_quantity: 1,
        webhook_url: null,
        active: 1,
        fields: "email" as const,
      };
      const intent = {
        eventId: 1,
        name: "John Doe",
        email: "john@example.com",
        phone: "",
        quantity: 1,
      };
      const result = await squareApi.createPaymentLink(
        event,
        intent,
        "http://localhost",
      );
      expect(result).toBeNull();
    });

    test("returns null when unit_price is null", async () => {
      await updateSquareAccessToken("EAAAl_test_123");
      await updateSquareLocationId("L_test_123");
      const event = {
        id: 1,
        slug: "test-event",
        slug_index: "test-event-index",
        name: "Test",
        description: "Desc",
        created: new Date().toISOString(),
        max_attendees: 50,
        thank_you_url: "https://example.com",
        unit_price: null,
        max_quantity: 1,
        webhook_url: null,
        active: 1,
        fields: "email" as const,
      };
      const intent = {
        eventId: 1,
        name: "John",
        email: "john@example.com",
        phone: "",
        quantity: 1,
      };
      const result = await squareApi.createPaymentLink(
        event,
        intent,
        "http://localhost",
      );
      expect(result).toBeNull();
    });

    test("returns null when location ID not configured", async () => {
      await updateSquareAccessToken("EAAAl_test_123");
      // No location ID set
      const event = {
        id: 1,
        slug: "test-event",
        slug_index: "test-event-index",
        name: "Test",
        description: "Desc",
        created: new Date().toISOString(),
        max_attendees: 50,
        thank_you_url: "https://example.com",
        unit_price: 1000,
        max_quantity: 1,
        webhook_url: null,
        active: 1,
        fields: "email" as const,
      };
      const intent = {
        eventId: 1,
        name: "John",
        email: "john@example.com",
        phone: "",
        quantity: 1,
      };
      const result = await squareApi.createPaymentLink(
        event,
        intent,
        "http://localhost",
      );
      expect(result).toBeNull();
    });
  });

  describe("createMultiPaymentLink", () => {
    test("returns null when access token not set", async () => {
      const intent = {
        name: "John Doe",
        email: "john@example.com",
        phone: "",
        items: [
          { eventId: 1, quantity: 1, unitPrice: 1000, slug: "event-1" },
          { eventId: 2, quantity: 2, unitPrice: 500, slug: "event-2" },
        ],
      };
      const result = await squareApi.createMultiPaymentLink(
        intent,
        "http://localhost",
      );
      expect(result).toBeNull();
    });

    test("returns null when location ID not configured", async () => {
      await updateSquareAccessToken("EAAAl_test_123");
      const intent = {
        name: "John Doe",
        email: "john@example.com",
        phone: "",
        items: [
          { eventId: 1, quantity: 1, unitPrice: 1000, slug: "event-1" },
        ],
      };
      const result = await squareApi.createMultiPaymentLink(
        intent,
        "http://localhost",
      );
      expect(result).toBeNull();
    });
  });

  describe("retrieveOrder", () => {
    test("returns null when access token not set", async () => {
      const result = await squareApi.retrieveOrder("order_123");
      expect(result).toBeNull();
    });
  });

  describe("retrievePayment", () => {
    test("returns null when access token not set", async () => {
      const result = await squareApi.retrievePayment("pay_123");
      expect(result).toBeNull();
    });
  });

  describe("refundPayment", () => {
    test("returns false when access token not set", async () => {
      const result = await squareApi.refundPayment("pay_123");
      expect(result).toBe(false);
    });

    test("returns false when payment has no amount info", async () => {
      const retrieveSpy = spyOn(squareApi, "retrievePayment")
        .mockResolvedValue({ id: "pay_123", status: "COMPLETED" });

      try {
        const result = await squareApi.refundPayment("pay_123");
        expect(result).toBe(false);
      } finally {
        retrieveSpy.mockRestore?.();
      }
    });

    test("returns false when payment retrieval returns null", async () => {
      const retrieveSpy = spyOn(squareApi, "retrievePayment")
        .mockResolvedValue(null);

      try {
        const result = await squareApi.refundPayment("pay_123");
        expect(result).toBe(false);
      } finally {
        retrieveSpy.mockRestore?.();
      }
    });
  });

  describe("verifyWebhookSignature", () => {
    const TEST_SECRET = "square_test_signature_key";
    const TEST_NOTIFICATION_URL = "https://example.com/payment/webhook";

    beforeEach(async () => {
      await updateSquareWebhookSignatureKey(TEST_SECRET);
    });

    test("returns error when webhook signature key not configured", async () => {
      await resetDb();
      await createTestDb();
      const result = await verifyWebhookSignature(
        '{"test": true}',
        "somesig",
        TEST_NOTIFICATION_URL,
      );
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toBe("Webhook signature key not configured");
      }
    });

    test("returns error when notification URL not provided", async () => {
      const result = await verifyWebhookSignature(
        '{"test": true}',
        "somesig",
      );
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toBe("Notification URL required for verification");
      }
    });

    test("returns error for invalid signature", async () => {
      const result = await verifyWebhookSignature(
        '{"test": true}',
        "invalidsignature",
        TEST_NOTIFICATION_URL,
      );
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toBe("Signature verification failed");
      }
    });

    test("returns error for invalid JSON payload with valid signature", async () => {
      const payload = "not valid json {{{";
      const { signature } = await constructTestWebhookEvent(
        // We'll sign the raw payload by constructing manually
        { id: "dummy", type: "dummy", data: { object: {} } },
        TEST_SECRET,
        TEST_NOTIFICATION_URL,
      );

      // Generate correct signature for invalid JSON payload
      const signedPayload = TEST_NOTIFICATION_URL + payload;
      const encoder = new TextEncoder();
      const key = await crypto.subtle.importKey(
        "raw",
        encoder.encode(TEST_SECRET),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );
      const sig = await crypto.subtle.sign(
        "HMAC",
        key,
        encoder.encode(signedPayload),
      );
      const sigBase64 = btoa(String.fromCharCode(...new Uint8Array(sig)));

      // Use the underscore prefix to suppress unused var lint
      void signature;

      const result = await verifyWebhookSignature(
        payload,
        sigBase64,
        TEST_NOTIFICATION_URL,
      );
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toBe("Invalid JSON payload");
      }
    });

    test("verifies valid signature successfully", async () => {
      const event: WebhookEvent = {
        id: "evt_square_123",
        type: "payment.updated",
        data: {
          object: {
            id: "pay_123",
            status: "COMPLETED",
            order_id: "order_456",
          },
        },
      };

      const { payload, signature } = await constructTestWebhookEvent(
        event,
        TEST_SECRET,
        TEST_NOTIFICATION_URL,
      );

      const result = await verifyWebhookSignature(
        payload,
        signature,
        TEST_NOTIFICATION_URL,
      );
      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.event.id).toBe("evt_square_123");
        expect(result.event.type).toBe("payment.updated");
      }
    });
  });

  describe("constructTestWebhookEvent", () => {
    test("creates valid payload and signature pair", async () => {
      const secret = "square_test_construction";
      const notificationUrl = "https://example.com/payment/webhook";
      const event: WebhookEvent = {
        id: "evt_constructed",
        type: "payment.updated",
        data: {
          object: {
            id: "pay_123",
            status: "COMPLETED",
          },
        },
      };

      const { payload, signature } = await constructTestWebhookEvent(
        event,
        secret,
        notificationUrl,
      );

      // Verify payload is valid JSON matching input
      const parsed = JSON.parse(payload);
      expect(parsed.id).toBe("evt_constructed");
      expect(parsed.type).toBe("payment.updated");

      // Signature should be base64-encoded
      expect(signature).toMatch(/^[A-Za-z0-9+/]+=*$/);

      // Signature should be verifiable with the same secret (stored in DB)
      await updateSquareWebhookSignatureKey(secret);
      const result = await verifyWebhookSignature(
        payload,
        signature,
        notificationUrl,
      );
      expect(result.valid).toBe(true);
    });
  });
});
