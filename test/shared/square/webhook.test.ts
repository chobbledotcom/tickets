import { expect } from "@std/expect";
import { beforeEach, describe, it as test } from "@std/testing/bdd";
import { spy } from "@std/testing/mock";
import { settings } from "#shared/db/settings.ts";
import type { WebhookEvent } from "#shared/payments.ts";
import {
  constructTestWebhookEvent,
  verifyWebhookSignature,
} from "#shared/square.ts";
import { describeSquare } from "#test/lib/square/harness.ts";
import { createTestDb, resetDb } from "#test-utils/db.ts";

describeSquare(() => {
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
      const error = spy(console, "error");
      try {
        await expectInvalid(
          '{"test": true}',
          "somesig",
          "Webhook signature key not configured",
        );
        expect(error.calls.at(-1)?.args).toEqual([
          '[Error] E_CONFIG_MISSING detail="Square webhook signature key"',
        ]);
      } finally {
        error.restore();
      }
    });

    test("returns error for invalid signature", async () => {
      const listing = {
        data: { object: {} },
        id: "expected-signature",
        type: "payment.updated",
      };
      const signed = await constructTestWebhookEvent(
        listing,
        TEST_SECRET,
        TEST_NOTIFICATION_URL,
      );
      const error = spy(console, "error");
      try {
        await expectInvalid(
          signed.payload,
          "invalidsignature",
          "Signature verification failed",
        );
        expect(error.calls.at(-1)?.args).toEqual([
          `[Error] E_SQUARE_SIGNATURE detail="mismatch: notificationUrl=${TEST_NOTIFICATION_URL}, receivedLength=16, expectedLength=${signed.signature.length}, receivedPrefix=invalids..., expectedPrefix=${signed.signature.slice(0, 8)}..., bodyLength=${toBytes(signed.payload).length}"`,
        ]);
      } finally {
        error.restore();
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

      const error = spy(console, "error");
      try {
        const result = await verify(payload, signature);
        expect(result.valid).toBe(true);
        expect(error.calls).toHaveLength(0);
        if (result.valid) {
          expect(result.listing.id).toBe("evt_square_123");
          expect(result.listing.type).toBe("payment.updated");
        }
      } finally {
        error.restore();
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
