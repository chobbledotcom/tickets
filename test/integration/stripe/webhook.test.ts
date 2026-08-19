import { expect } from "@std/expect";
import { beforeEach, describe, it as test } from "@std/testing/bdd";
import {
  type StripeWebhookEvent,
  verifyWebhookSignature,
} from "#shared/stripe/webhook.ts";
import { createTestDb, resetDb } from "#test-utils/db.ts";
import { activateStripe } from "#test-utils/settings.ts";
import { signedHeader, signedWebhook } from "#test-utils/stripe/fixtures.ts";
import { describeStripe } from "#test-utils/stripe/harness.ts";

describeStripe("stripe", () => {
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

      const { payload, signature } = await signedWebhook(listing, TEST_SECRET);

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
