import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { setAllowedDomainForTest } from "#lib/config.ts";
import { PaymentUserError } from "#lib/payment-helpers.ts";
import { squareApi } from "#lib/square.ts";
import { squarePaymentProvider } from "#lib/square-provider.ts";
import { createTestDb, resetDb, testEvent, withMocks } from "#test-utils";

describe("square-provider", () => {
  beforeEach(async () => {
    await createTestDb();
    setAllowedDomainForTest("example.com");
  });

  afterEach(() => {
    resetDb();
  });

  describe("retrieveSession", () => {
    test("returns null when order metadata is missing required fields", async () => {
      await withMocks(
        () =>
          stub(squareApi, "retrieveOrder", () =>
            Promise.resolve({
              id: "order_no_meta",
              metadata: {},
              state: "COMPLETED",
              totalMoney: { amount: BigInt(1000), currency: "USD" },
            }),
          ),
        async () => {
          const result =
            await squarePaymentProvider.retrieveSession("order_no_meta");
          expect(result).toBeNull();
        },
      );
    });

    test("returns paid when payment status is COMPLETED", async () => {
      await withMocks(
        () => ({
          order: stub(squareApi, "retrieveOrder", () =>
            Promise.resolve({
              id: "order_completed",
              metadata: {
                name: "Alice",
                email: "alice@example.com",
                event_id: "1",
                quantity: "1",
              },
              tenders: [{ id: "tender_1", paymentId: "pay_1" }],
              state: "COMPLETED",
              totalMoney: { amount: BigInt(1000), currency: "USD" },
            }),
          ),
          payment: stub(squareApi, "retrievePayment", () =>
            Promise.resolve({
              id: "pay_1",
              status: "COMPLETED",
            }),
          ),
        }),
        async (mocks) => {
          const result =
            await squarePaymentProvider.retrieveSession("order_completed");
          expect(result).not.toBeNull();
          expect(result!.paymentStatus).toBe("paid");
          expect(result!.paymentReference).toBe("pay_1");
          expect(mocks.payment.calls[0]!.args).toEqual(["pay_1"]);
        },
      );
    });

    test("returns paid when order state is OPEN but payment is COMPLETED", async () => {
      await withMocks(
        () => ({
          order: stub(squareApi, "retrieveOrder", () =>
            Promise.resolve({
              id: "order_open",
              metadata: {
                name: "Bob",
                email: "bob@example.com",
                event_id: "1",
                quantity: "1",
              },
              tenders: [{ id: "tender_1", paymentId: "pay_2" }],
              state: "OPEN",
              totalMoney: { amount: BigInt(1000), currency: "USD" },
            }),
          ),
          payment: stub(squareApi, "retrievePayment", () =>
            Promise.resolve({
              id: "pay_2",
              status: "COMPLETED",
            }),
          ),
        }),
        async (mocks) => {
          const result =
            await squarePaymentProvider.retrieveSession("order_open");
          expect(result).not.toBeNull();
          expect(result!.paymentStatus).toBe("paid");
          expect(result!.paymentReference).toBe("pay_2");
          expect(mocks.payment.calls[0]!.args).toEqual(["pay_2"]);
        },
      );
    });

    test("returns unpaid when order state is OPEN and payment is not COMPLETED", async () => {
      await withMocks(
        () => ({
          order: stub(squareApi, "retrieveOrder", () =>
            Promise.resolve({
              id: "order_open",
              metadata: {
                name: "Carol",
                email: "carol@example.com",
                event_id: "1",
                quantity: "1",
              },
              tenders: [{ id: "tender_1", paymentId: "pay_3" }],
              state: "OPEN",
              totalMoney: { amount: BigInt(1000), currency: "USD" },
            }),
          ),
          payment: stub(squareApi, "retrievePayment", () =>
            Promise.resolve({
              id: "pay_3",
              status: "PENDING",
            }),
          ),
        }),
        async () => {
          const result =
            await squarePaymentProvider.retrieveSession("order_open");
          expect(result).not.toBeNull();
          expect(result!.paymentStatus).toBe("unpaid");
        },
      );
    });

    test("returns unpaid when order state is OPEN and no tenders exist", async () => {
      await withMocks(
        () =>
          stub(squareApi, "retrieveOrder", () =>
            Promise.resolve({
              id: "order_no_tenders",
              metadata: {
                name: "Dave",
                email: "dave@example.com",
                event_id: "1",
                quantity: "1",
              },
              state: "OPEN",
              totalMoney: { amount: BigInt(1000), currency: "USD" },
            }),
          ),
        async () => {
          const result =
            await squarePaymentProvider.retrieveSession("order_no_tenders");
          expect(result).not.toBeNull();
          expect(result!.paymentStatus).toBe("unpaid");
        },
      );
    });
  });

  describe("isPaymentRefunded", () => {
    test("returns true when payment has refundedMoney", async () => {
      await withMocks(
        () =>
          stub(squareApi, "retrievePayment", () =>
            Promise.resolve({
              id: "pay_123",
              status: "COMPLETED",
              refundedMoney: { amount: BigInt(1000), currency: "USD" },
            }),
          ),
        async () => {
          const result =
            await squarePaymentProvider.isPaymentRefunded("pay_123");
          expect(result).toBe(true);
        },
      );
    });

    test("returns false when refundedMoney is zero", async () => {
      await withMocks(
        () =>
          stub(squareApi, "retrievePayment", () =>
            Promise.resolve({
              id: "pay_123",
              status: "COMPLETED",
              refundedMoney: { amount: BigInt(0), currency: "USD" },
            }),
          ),
        async () => {
          const result =
            await squarePaymentProvider.isPaymentRefunded("pay_123");
          expect(result).toBe(false);
        },
      );
    });

    test("returns false when payment not found", async () => {
      await withMocks(
        () => stub(squareApi, "retrievePayment", () => Promise.resolve(null)),
        async () => {
          const result =
            await squarePaymentProvider.isPaymentRefunded("pay_missing");
          expect(result).toBe(false);
        },
      );
    });

    test("returns false when refundedMoney is missing", async () => {
      await withMocks(
        () =>
          stub(squareApi, "retrievePayment", () =>
            Promise.resolve({
              id: "pay_123",
              status: "COMPLETED",
            }),
          ),
        async () => {
          const result =
            await squarePaymentProvider.isPaymentRefunded("pay_123");
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
        () =>
          stub(squareApi, "createPaymentLink", () => {
            throw new PaymentUserError("Phone number is invalid");
          }),
        async () => {
          const result = await squarePaymentProvider.createCheckoutSession(
            event,
            intent,
            "http://localhost",
          );
          expect(result).not.toBeNull();
          expect(result).toHaveProperty("error");
          expect((result as { error: string }).error).toBe(
            "Phone number is invalid",
          );
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
        () =>
          stub(squareApi, "createPaymentLink", () => {
            throw new Error("Network failure");
          }),
        async () => {
          const result = await squarePaymentProvider.createCheckoutSession(
            event,
            intent,
            "http://localhost",
          );
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
        items: [
          {
            eventId: 1,
            quantity: 1,
            unitPrice: 1000,
            slug: "evt",
            name: "Evt",
          },
        ],
      };
      await withMocks(
        () =>
          stub(squareApi, "createMultiPaymentLink", () => {
            throw new PaymentUserError("Email address is invalid");
          }),
        async () => {
          const result = await squarePaymentProvider.createMultiCheckoutSession(
            intent,
            "http://localhost",
          );
          expect(result).not.toBeNull();
          expect(result).toHaveProperty("error");
          expect((result as { error: string }).error).toBe(
            "Email address is invalid",
          );
        },
      );
    });
  });

  describe("resolveWebhookSession", () => {
    test("extracts order_id from nested Square payment object", async () => {
      await withMocks(
        () => ({
          order: stub(squareApi, "retrieveOrder", () =>
            Promise.resolve({
              id: "order_nested_456",
              metadata: {
                name: "Alice",
                email: "alice@example.com",
                event_id: "1",
                quantity: "1",
              },
              tenders: [{ id: "tender_1", paymentId: "pay_nested_123" }],
              state: "COMPLETED",
              totalMoney: { amount: BigInt(1000), currency: "USD" },
            }),
          ),
          payment: stub(squareApi, "retrievePayment", () =>
            Promise.resolve({
              id: "pay_nested_123",
              status: "COMPLETED",
            }),
          ),
        }),
        async (mocks) => {
          const result = await squarePaymentProvider.resolveWebhookSession({
            id: "evt_square",
            type: "payment.updated",
            data: {
              object: {
                payment: {
                  id: "pay_nested_123",
                  order_id: "order_nested_456",
                  status: "COMPLETED",
                },
              },
            },
          });
          expect(result).not.toBe("skip");
          expect(result).not.toBeNull();
          expect(mocks.order.calls[0]!.args[0]).toBe("order_nested_456");
        },
      );
    });

    test("returns skip for non-COMPLETED payment status", async () => {
      const result = await squarePaymentProvider.resolveWebhookSession({
        id: "evt_pending",
        type: "payment.updated",
        data: {
          object: {
            payment: {
              id: "pay_pending",
              order_id: "order_pending",
              status: "APPROVED",
            },
          },
        },
      });
      expect(result).toBe("skip");
    });

    test("returns null when no order_id or id found", async () => {
      const result = await squarePaymentProvider.resolveWebhookSession({
        id: "evt_no_id",
        type: "payment.updated",
        data: {
          object: {
            payment: {
              status: "COMPLETED",
            },
          },
        },
      });
      expect(result).toBeNull();
    });

    test("falls back to payment id when order_id is missing", async () => {
      await withMocks(
        () => ({
          order: stub(squareApi, "retrieveOrder", () => Promise.resolve(null)),
        }),
        async (mocks) => {
          const result = await squarePaymentProvider.resolveWebhookSession({
            id: "evt_no_order",
            type: "payment.updated",
            data: {
              object: {
                payment: {
                  id: "pay_fallback_id",
                  status: "COMPLETED",
                },
              },
            },
          });
          // retrieveSession called with payment id as fallback
          expect(mocks.order.calls[0]!.args[0]).toBe("pay_fallback_id");
          expect(result).toBeNull();
        },
      );
    });

    test("handles flat event object without payment wrapper", async () => {
      await withMocks(
        () => stub(squareApi, "retrieveOrder", () => Promise.resolve(null)),
        async (mockOrder) => {
          const result = await squarePaymentProvider.resolveWebhookSession({
            id: "evt_flat",
            type: "payment.updated",
            data: {
              object: {
                id: "pay_flat",
                order_id: "order_flat",
                status: "COMPLETED",
              },
            },
          });
          expect(mockOrder.calls[0]!.args[0]).toBe("order_flat");
          expect(result).toBeNull();
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
