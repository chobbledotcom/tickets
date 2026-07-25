import { expect } from "@std/expect";
import { beforeEach, describe, it as test } from "@std/testing/bdd";
import { settings } from "#shared/db/settings.ts";
import type { WebhookEvent } from "#shared/payments.ts";
import {
  constructTestWebhookEvent,
  verifyWebhookSignature,
} from "#shared/square.ts";
import { describeSquare } from "#test/lib/square/harness.ts";
import { createTestDb, resetDb } from "#test-utils/db.ts";
import { setupErrorSpy } from "#test-utils/error-spy.ts";

describeSquare(() => {
  const errors = setupErrorSpy();

  describe("verifyWebhookSignature", () => {
    const TEST_SECRET = "square_test_signature_key";
    const TEST_NOTIFICATION_URL = "https://example.com/payment/webhook";
    const toBytes = (s: string) => new TextEncoder().encode(s);

    /** Verify a payload against a signature using the shared notification URL. */
    const verify = (payload: string, signature: string) =>
      verifyWebhookSignature(
        payload,
        signature,
        TEST_NOTIFICATION_URL,
        toBytes(payload),
      );

    /** The verification should reject the payload with exactly `error`. */
    const expectInvalid = async (
      payload: string,
      signature: string,
      error: string,
    ) => {
      const result = await verify(payload, signature);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toBe(error);
      }
    };

    beforeEach(async () => {
      await settings.update.square.webhookSignatureKey(TEST_SECRET);
    });

    test("returns error when webhook signature key not configured", async () => {
      await resetDb();
      await createTestDb();
      await expectInvalid(
        '{"test": true}',
        "somesig",
        "Webhook signature key not configured",
      );
      expect(errors.lastMessage()).toContain("Square webhook signature key");
    });

    test("returns error for invalid signature", async () => {
      const listing: WebhookEvent = {
        data: { object: {} },
        id: "evt_invalid_signature",
        type: "payment.updated",
      };
      const { payload, signature: expectedSignature } =
        await constructTestWebhookEvent(
          listing,
          TEST_SECRET,
          TEST_NOTIFICATION_URL,
        );
      const receivedSignature = "mismatched-sig";
      await expectInvalid(
        payload,
        receivedSignature,
        "Signature verification failed",
      );
      expect(errors.calls).toHaveLength(1);
      expect(errors.calls[0]!.args[0]).toBe(
        `[Error] E_SQUARE_SIGNATURE detail="mismatch: notificationUrl=${TEST_NOTIFICATION_URL}, receivedLength=${receivedSignature.length}, expectedLength=${expectedSignature.length}, receivedPrefix=${receivedSignature.slice(0, 8)}..., expectedPrefix=${expectedSignature.slice(0, 8)}..., bodyLength=${toBytes(payload).length}"`,
      );
    });

    test("does not log an error for a valid signature", async () => {
      const listing: WebhookEvent = {
        data: { object: {} },
        id: "evt_valid_signature",
        type: "payment.updated",
      };
      const { payload, signature } = await constructTestWebhookEvent(
        listing,
        TEST_SECRET,
        TEST_NOTIFICATION_URL,
      );
      expect(await verify(payload, signature)).toEqual({
        listing,
        valid: true,
      });
      expect(errors.calls).toHaveLength(0);
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

      await expectInvalid(payload, sigBase64, "Invalid JSON payload");
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

      const result = await verify(payload, signature);
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
