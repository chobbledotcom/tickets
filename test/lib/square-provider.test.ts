import { afterEach, beforeEach, describe, expect, spyOn, test } from "#test-compat";
import { squarePaymentProvider } from "#lib/square-provider.ts";
import { squareApi } from "#lib/square.ts";
import { PaymentUserError } from "#lib/payment-helpers.ts";
import { createTestDb, resetDb, testEvent, withMocks } from "#test-utils";

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

  describe("createCheckoutSession", () => {
    test("returns error result when createPaymentLink throws PaymentUserError", async () => {
      const event = testEvent({ unit_price: 1000, fields: "email" as const });
      const intent = {
        eventId: 1,
        name: "John",
        email: "john@example.com",
        phone: "bad",
        address: "",
        special_instructions: "",
        quantity: 1,
      };
      await withMocks(
        () => spyOn(squareApi, "createPaymentLink").mockImplementation(() => {
          throw new PaymentUserError("The payment processor rejected the phone number as invalid. Please correct it and try again.");
        }),
        async () => {
          const result = await squarePaymentProvider.createCheckoutSession(event, intent, "http://localhost");
          expect(result).not.toBeNull();
          expect(result).toHaveProperty("error");
          expect((result as { error: string }).error).toContain("phone number");
        },
      );
    });

    test("returns null when createPaymentLink throws a generic error", async () => {
      const event = testEvent({ unit_price: 1000, fields: "email" as const });
      const intent = {
        eventId: 1,
        name: "John",
        email: "john@example.com",
        phone: "",
        address: "",
        special_instructions: "",
        quantity: 1,
      };
      await withMocks(
        () => spyOn(squareApi, "createPaymentLink").mockImplementation(() => {
          throw new Error("Network failure");
        }),
        async () => {
          const result = await squarePaymentProvider.createCheckoutSession(event, intent, "http://localhost");
          expect(result).toBeNull();
        },
      );
    });
  });

  describe("createMultiCheckoutSession", () => {
    test("returns error result when createMultiPaymentLink throws PaymentUserError", async () => {
      const intent = {
        name: "John",
        email: "bad",
        phone: "",
        address: "",
        special_instructions: "",
        items: [{ eventId: 1, quantity: 1, unitPrice: 1000, slug: "evt", name: "Evt" }],
      };
      await withMocks(
        () => spyOn(squareApi, "createMultiPaymentLink").mockImplementation(() => {
          throw new PaymentUserError("The payment processor rejected the email address as invalid. Please correct it and try again.");
        }),
        async () => {
          const result = await squarePaymentProvider.createMultiCheckoutSession(intent, "http://localhost");
          expect(result).not.toBeNull();
          expect(result).toHaveProperty("error");
          expect((result as { error: string }).error).toContain("email address");
        },
      );
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
