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
      await withMocks(
        () => spyOn(squareApi, "retrieveOrder").mockResolvedValue({
          id: "order_no_meta",
          metadata: {},
          state: "COMPLETED",
          totalMoney: { amount: BigInt(1000), currency: "USD" },
        }),
        async () => {
          const result = await squarePaymentProvider.retrieveSession("order_no_meta");
          expect(result).toBeNull();
        },
      );
    });

    test("returns paid when payment status is COMPLETED", async () => {
      await withMocks(
        () => ({
          order: spyOn(squareApi, "retrieveOrder").mockResolvedValue({
            id: "order_completed",
            metadata: { name: "Alice", email: "alice@example.com", event_id: "1", quantity: "1" },
            tenders: [{ id: "tender_1", paymentId: "pay_1" }],
            state: "COMPLETED",
            totalMoney: { amount: BigInt(1000), currency: "USD" },
          }),
          payment: spyOn(squareApi, "retrievePayment").mockResolvedValue({
            id: "pay_1",
            status: "COMPLETED",
          }),
        }),
        async (mocks) => {
          const result = await squarePaymentProvider.retrieveSession("order_completed");
          expect(result).not.toBeNull();
          expect(result!.paymentStatus).toBe("paid");
          expect(result!.paymentReference).toBe("pay_1");
          expect(mocks.payment).toHaveBeenCalledWith("pay_1");
        },
      );
    });

    test("returns paid when order state is OPEN but payment is COMPLETED", async () => {
      await withMocks(
        () => ({
          order: spyOn(squareApi, "retrieveOrder").mockResolvedValue({
            id: "order_open",
            metadata: { name: "Bob", email: "bob@example.com", event_id: "1", quantity: "1" },
            tenders: [{ id: "tender_1", paymentId: "pay_2" }],
            state: "OPEN",
            totalMoney: { amount: BigInt(1000), currency: "USD" },
          }),
          payment: spyOn(squareApi, "retrievePayment").mockResolvedValue({
            id: "pay_2",
            status: "COMPLETED",
          }),
        }),
        async (mocks) => {
          const result = await squarePaymentProvider.retrieveSession("order_open");
          expect(result).not.toBeNull();
          expect(result!.paymentStatus).toBe("paid");
          expect(result!.paymentReference).toBe("pay_2");
          expect(mocks.payment).toHaveBeenCalledWith("pay_2");
        },
      );
    });

    test("returns unpaid when order state is OPEN and payment is not COMPLETED", async () => {
      await withMocks(
        () => ({
          order: spyOn(squareApi, "retrieveOrder").mockResolvedValue({
            id: "order_open",
            metadata: { name: "Carol", email: "carol@example.com", event_id: "1", quantity: "1" },
            tenders: [{ id: "tender_1", paymentId: "pay_3" }],
            state: "OPEN",
            totalMoney: { amount: BigInt(1000), currency: "USD" },
          }),
          payment: spyOn(squareApi, "retrievePayment").mockResolvedValue({
            id: "pay_3",
            status: "PENDING",
          }),
        }),
        async () => {
          const result = await squarePaymentProvider.retrieveSession("order_open");
          expect(result).not.toBeNull();
          expect(result!.paymentStatus).toBe("unpaid");
        },
      );
    });

    test("returns unpaid when order state is OPEN and no tenders exist", async () => {
      await withMocks(
        () => spyOn(squareApi, "retrieveOrder").mockResolvedValue({
          id: "order_no_tenders",
          metadata: { name: "Dave", email: "dave@example.com", event_id: "1", quantity: "1" },
          state: "OPEN",
          totalMoney: { amount: BigInt(1000), currency: "USD" },
        }),
        async () => {
          const result = await squarePaymentProvider.retrieveSession("order_no_tenders");
          expect(result).not.toBeNull();
          expect(result!.paymentStatus).toBe("unpaid");
        },
      );
    });

  });

  describe("isPaymentRefunded", () => {
    test("returns true when payment has refundedMoney", async () => {
      await withMocks(
        () => spyOn(squareApi, "retrievePayment").mockResolvedValue({
          id: "pay_123",
          status: "COMPLETED",
          refundedMoney: { amount: BigInt(1000), currency: "USD" },
        }),
        async () => {
          const result = await squarePaymentProvider.isPaymentRefunded("pay_123");
          expect(result).toBe(true);
        },
      );
    });

    test("returns false when refundedMoney is zero", async () => {
      await withMocks(
        () => spyOn(squareApi, "retrievePayment").mockResolvedValue({
          id: "pay_123",
          status: "COMPLETED",
          refundedMoney: { amount: BigInt(0), currency: "USD" },
        }),
        async () => {
          const result = await squarePaymentProvider.isPaymentRefunded("pay_123");
          expect(result).toBe(false);
        },
      );
    });

    test("returns false when payment not found", async () => {
      await withMocks(
        () => spyOn(squareApi, "retrievePayment").mockResolvedValue(null),
        async () => {
          const result = await squarePaymentProvider.isPaymentRefunded("pay_missing");
          expect(result).toBe(false);
        },
      );
    });

    test("returns false when refundedMoney is missing", async () => {
      await withMocks(
        () => spyOn(squareApi, "retrievePayment").mockResolvedValue({
          id: "pay_123",
          status: "COMPLETED",
        }),
        async () => {
          const result = await squarePaymentProvider.isPaymentRefunded("pay_123");
          expect(result).toBe(false);
        },
      );
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
          throw new PaymentUserError("Phone number is invalid");
        }),
        async () => {
          const result = await squarePaymentProvider.createCheckoutSession(event, intent, "http://localhost");
          expect(result).not.toBeNull();
          expect(result).toHaveProperty("error");
          expect((result as { error: string }).error).toBe("Phone number is invalid");
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
          throw new PaymentUserError("Email address is invalid");
        }),
        async () => {
          const result = await squarePaymentProvider.createMultiCheckoutSession(intent, "http://localhost");
          expect(result).not.toBeNull();
          expect(result).toHaveProperty("error");
          expect((result as { error: string }).error).toBe("Email address is invalid");
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
