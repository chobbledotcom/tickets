import { afterEach, beforeEach, describe, expect, spyOn, test } from "#test-compat";
import { squarePaymentProvider } from "#lib/square-provider.ts";
import { squareApi } from "#lib/square.ts";
import { createTestDb, resetDb } from "#test-utils";

describe("square-provider", () => {
  beforeEach(async () => {
    await createTestDb();
    Deno.env.set("ALLOWED_DOMAIN", "example.com");
  });

  afterEach(() => {
    resetDb();
    Deno.env.set("ALLOWED_DOMAIN", "localhost");
  });

  describe("retrieveSession", () => {
    test("returns null when order metadata is missing required fields", async () => {
      const restore = spyOn(squareApi, "retrieveOrder").mockResolvedValue({
        id: "order_no_meta",
        metadata: {},
        state: "COMPLETED",
        totalMoney: { amount: BigInt(1000), currency: "USD" },
      });
      const result = await squarePaymentProvider.retrieveSession("order_no_meta");
      expect(result).toBeNull();
      restore();
    });
  });

  describe("isPaymentRefunded", () => {
    test("returns true when payment has refundedMoney", async () => {
      const restore = spyOn(squareApi, "retrievePayment").mockResolvedValue({
        id: "pay_123",
        status: "COMPLETED",
        refundedMoney: { amount: BigInt(1000), currency: "USD" },
      });
      const result = await squarePaymentProvider.isPaymentRefunded("pay_123");
      expect(result).toBe(true);
      restore();
    });

    test("returns false when refundedMoney is zero", async () => {
      const restore = spyOn(squareApi, "retrievePayment").mockResolvedValue({
        id: "pay_123",
        status: "COMPLETED",
        refundedMoney: { amount: BigInt(0), currency: "USD" },
      });
      const result = await squarePaymentProvider.isPaymentRefunded("pay_123");
      expect(result).toBe(false);
      restore();
    });

    test("returns false when payment not found", async () => {
      const restore = spyOn(squareApi, "retrievePayment").mockResolvedValue(null);
      const result = await squarePaymentProvider.isPaymentRefunded("pay_missing");
      expect(result).toBe(false);
      restore();
    });

    test("returns false when refundedMoney is missing", async () => {
      const restore = spyOn(squareApi, "retrievePayment").mockResolvedValue({
        id: "pay_123",
        status: "COMPLETED",
      });
      const result = await squarePaymentProvider.isPaymentRefunded("pay_123");
      expect(result).toBe(false);
      restore();
    });
  });

  describe("setupWebhookEndpoint", () => {
    test("returns failure since Square webhooks are manual", async () => {
      const result = await squarePaymentProvider.setupWebhookEndpoint(
        "key",
        "https://example.com/webhook",
      );
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("Square Developer Dashboard");
      }
    });
  });
});
