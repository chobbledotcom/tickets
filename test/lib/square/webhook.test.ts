import { expect } from "@std/expect";
import { beforeEach, describe, it as test } from "@std/testing/bdd";
import { settings } from "#shared/db/settings.ts";
import type { WebhookEvent } from "#shared/payments.ts";
import {
  constructTestWebhookEvent,
  verifyWebhookSignature,
} from "#shared/square.ts";
import { createTestDb, resetDb } from "#test-utils";
import { describeSquare } from "./harness.ts";

describeSquare(() => {
  describe("verifyWebhookSignature", () => {
    const TEST_SECRET = "square_test_signature_key";
    const TEST_NOTIFICATION_URL = "https://example.com/payment/webhook";
    const toBytes = (s: string) => new TextEncoder().encode(s);

    beforeEach(async () => {
      await settings.update.square.webhookSignatureKey(TEST_SECRET);
    });

    test("returns error when webhook signature key not configured", async () => {
      await resetDb();
      await createTestDb();
      const payload = '{"test": true}';
      const result = await verifyWebhookSignature(
        payload,
        "somesig",
        TEST_NOTIFICATION_URL,
        toBytes(payload),
      );
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toBe("Webhook signature key not configured");
      }
    });

    test("returns error for invalid signature", async () => {
      const payload = '{"test": true}';
      const result = await verifyWebhookSignature(
        payload,
        "invalidsignature",
        TEST_NOTIFICATION_URL,
        toBytes(payload),
      );
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toBe("Signature verification failed");
      }
    });

    test("returns error for invalid JSON payload with valid signature", async () => {
      const payload = "not valid json {{{";
      // Generate correct signature for invalid JSON payload
      const encoder = new TextEncoder();
      const urlBytes = encoder.encode(TEST_NOTIFICATION_URL);
      const bodyBytes = encoder.encode(payload);
      const combined = new Uint8Array(urlBytes.length + bodyBytes.length);
      combined.set(urlBytes);
      combined.set(bodyBytes, urlBytes.length);

      const key = await crypto.subtle.importKey(
        "raw",
        encoder.encode(TEST_SECRET),
        { hash: "SHA-256", name: "HMAC" },
        false,
        ["sign"],
      );
      const sig = await crypto.subtle.sign("HMAC", key, combined);
      const sigBase64 = btoa(String.fromCharCode(...new Uint8Array(sig)));

      const result = await verifyWebhookSignature(
        payload,
        sigBase64,
        TEST_NOTIFICATION_URL,
        toBytes(payload),
      );
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toBe("Invalid JSON payload");
      }
    });

    test("verifies valid signature successfully", async () => {
      const listing: WebhookEvent = {
        data: {
          object: {
            id: "pay_123",
            order_id: "order_456",
            status: "COMPLETED",
          },
        },
        id: "evt_square_123",
        type: "payment.updated",
      };

      const { payload, signature } = await constructTestWebhookEvent(
        listing,
        TEST_SECRET,
        TEST_NOTIFICATION_URL,
      );

      const result = await verifyWebhookSignature(
        payload,
        signature,
        TEST_NOTIFICATION_URL,
        toBytes(payload),
      );
      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.listing.id).toBe("evt_square_123");
        expect(result.listing.type).toBe("payment.updated");
      }
    });
  });

  describe("constructTestWebhookEvent", () => {
    test("creates valid payload and signature pair", async () => {
      const secret = "square_test_construction";
      const notificationUrl = "https://example.com/payment/webhook";
      const listing: WebhookEvent = {
        data: {
          object: {
            id: "pay_123",
            status: "COMPLETED",
          },
        },
        id: "evt_constructed",
        type: "payment.updated",
      };

      const { payload, signature } = await constructTestWebhookEvent(
        listing,
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
      await settings.update.square.webhookSignatureKey(secret);
      const result = await verifyWebhookSignature(
        payload,
        signature,
        notificationUrl,
        new TextEncoder().encode(payload),
      );
      expect(result.valid).toBe(true);
    });
  });
});
