import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { setEffectiveDomainForTest } from "#shared/config.ts";
import { PaymentUserError } from "#shared/payment-helpers.ts";
import { squareApi } from "#shared/square.ts";
import { squarePaymentProvider } from "#shared/square-provider.ts";
import { createTestDb, resetDb, testListing, withMocks } from "#test-utils";

describe("square-provider", () => {
  beforeEach(async () => {
    await createTestDb();
    setEffectiveDomainForTest("example.com");
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
                email: "alice@example.com",
                items: '[{"e":1,"q":1,"p":0}]',
                name: "Alice",
              },
              state: "COMPLETED",
              tenders: [{ id: "tender_1", paymentId: "pay_1" }],
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

    test("normalises a non-canonical order date to canonical ISO", async () => {
      await withMocks(
        () => ({
          order: stub(squareApi, "retrieveOrder", () =>
            Promise.resolve({
              // Square timestamps can omit milliseconds; the ledger needs .sssZ.
              createdAt: "2026-06-20T09:00:00Z",
              id: "order_dated",
              metadata: {
                email: "alice@example.com",
                items: '[{"e":1,"q":1,"p":0}]',
                name: "Alice",
              },
              state: "COMPLETED",
              tenders: [{ id: "tender_1", paymentId: "pay_1" }],
              totalMoney: { amount: BigInt(1000), currency: "USD" },
            }),
          ),
          payment: stub(squareApi, "retrievePayment", () =>
            Promise.resolve({ id: "pay_1", status: "COMPLETED" }),
          ),
        }),
        async () => {
          const result =
            await squarePaymentProvider.retrieveSession("order_dated");
          expect(result!.createdAt).toBe("2026-06-20T09:00:00.000Z");
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
                email: "bob@example.com",
                items: '[{"e":1,"q":1,"p":0}]',
                name: "Bob",
              },
              state: "OPEN",
              tenders: [{ id: "tender_1", paymentId: "pay_2" }],
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
                email: "carol@example.com",
                items: '[{"e":1,"q":1,"p":0}]',
                name: "Carol",
              },
              state: "OPEN",
              tenders: [{ id: "tender_1", paymentId: "pay_3" }],
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
                email: "dave@example.com",
                items: '[{"e":1,"q":1,"p":0}]',
                name: "Dave",
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
    test("returns true when fully refunded", async () => {
      await withMocks(
        () =>
          stub(squareApi, "retrievePayment", () =>
            Promise.resolve({
              amountMoney: { amount: BigInt(1000), currency: "USD" },
              id: "pay_123",
              refundedMoney: { amount: BigInt(1000), currency: "USD" },
              status: "COMPLETED",
            }),
          ),
        async () => {
          const result =
            await squarePaymentProvider.isPaymentRefunded("pay_123");
          expect(result).toBe(true);
        },
      );
    });

    test("returns false when only partially refunded", async () => {
      await withMocks(
        () =>
          stub(squareApi, "retrievePayment", () =>
            Promise.resolve({
              amountMoney: { amount: BigInt(1000), currency: "USD" },
              id: "pay_123",
              refundedMoney: { amount: BigInt(400), currency: "USD" },
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

    test("returns false when the charged amount is unknown", async () => {
      // Without amountMoney we cannot confirm a full refund, so a present
      // refundedMoney must not be treated as fully refunded.
      await withMocks(
        () =>
          stub(squareApi, "retrievePayment", () =>
            Promise.resolve({
              id: "pay_123",
              refundedMoney: { amount: BigInt(1000), currency: "USD" },
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

    test("returns false when refundedMoney is zero", async () => {
      await withMocks(
        () =>
          stub(squareApi, "retrievePayment", () =>
            Promise.resolve({
              amountMoney: { amount: BigInt(1000), currency: "USD" },
              id: "pay_123",
              refundedMoney: { amount: BigInt(0), currency: "USD" },
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
              amountMoney: { amount: BigInt(1000), currency: "USD" },
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
      const listing = testListing({
        fields: "email" as const,
        unit_price: 1000,
      });
      const intent = {
        address: "",
        date: null,
        email: "john@example.com",
        items: [
          {
            listingId: listing.id,
            name: listing.name,
            quantity: 1,
            slug: listing.slug,
            unitPrice: listing.unit_price,
          },
        ],
        name: "John",
        phone: "bad",
        special_instructions: "",
      };
      await withMocks(
        () =>
          stub(squareApi, "createPaymentLink", () => {
            throw new PaymentUserError("Phone number is invalid");
          }),
        async () => {
          const result = await squarePaymentProvider.createCheckoutSession(
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
      const listing = testListing({
        fields: "email" as const,
        unit_price: 1000,
      });
      const intent = {
        address: "",
        date: null,
        email: "john@example.com",
        items: [
          {
            listingId: listing.id,
            name: listing.name,
            quantity: 1,
            slug: listing.slug,
            unitPrice: listing.unit_price,
          },
        ],
        name: "John",
        phone: "",
        special_instructions: "",
      };
      await withMocks(
        () =>
          stub(squareApi, "createPaymentLink", () => {
            throw new Error("Network failure");
          }),
        async () => {
          const result = await squarePaymentProvider.createCheckoutSession(
            intent,
            "http://localhost",
          );
          expect(result).toBeNull();
        },
      );
    });
  });

  describe("createCheckoutSession", () => {
    test("returns error result when createPaymentLink throws PaymentUserError", async () => {
      const intent = {
        address: "",
        date: null,
        email: "bad",
        items: [
          {
            listingId: 1,
            name: "Evt",
            quantity: 1,
            slug: "evt",
            unitPrice: 1000,
          },
        ],
        name: "John",
        phone: "",
        special_instructions: "",
      };
      await withMocks(
        () =>
          stub(squareApi, "createPaymentLink", () => {
            throw new PaymentUserError("Email address is invalid");
          }),
        async () => {
          const result = await squarePaymentProvider.createCheckoutSession(
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
                email: "alice@example.com",
                items: '[{"e":1,"q":1,"p":0}]',
                name: "Alice",
              },
              state: "COMPLETED",
              tenders: [{ id: "tender_1", paymentId: "pay_nested_123" }],
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
            data: {
              object: {
                payment: {
                  id: "pay_nested_123",
                  order_id: "order_nested_456",
                  status: "COMPLETED",
                },
              },
            },
            id: "evt_square",
            type: "payment.updated",
          });
          expect(result).not.toBe("skip");
          expect(result).not.toBeNull();
          expect(mocks.order.calls[0]!.args[0]).toBe("order_nested_456");
        },
      );
    });

    test("returns skip for non-COMPLETED payment status", async () => {
      const result = await squarePaymentProvider.resolveWebhookSession({
        data: {
          object: {
            payment: {
              id: "pay_pending",
              order_id: "order_pending",
              status: "APPROVED",
            },
          },
        },
        id: "evt_pending",
        type: "payment.updated",
      });
      expect(result).toBe("skip");
    });

    test("returns null when no order_id or id found", async () => {
      const result = await squarePaymentProvider.resolveWebhookSession({
        data: {
          object: {
            payment: {
              status: "COMPLETED",
            },
          },
        },
        id: "evt_no_id",
        type: "payment.updated",
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
            data: {
              object: {
                payment: {
                  id: "pay_fallback_id",
                  status: "COMPLETED",
                },
              },
            },
            id: "evt_no_order",
            type: "payment.updated",
          });
          // retrieveSession called with payment id as fallback
          expect(mocks.order.calls[0]!.args[0]).toBe("pay_fallback_id");
          expect(result).toBe("skip");
        },
      );
    });

    test("returns skip when order exists but has no metadata", async () => {
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
          const result = await squarePaymentProvider.resolveWebhookSession({
            data: {
              object: {
                payment: {
                  id: "pay_no_meta",
                  order_id: "order_no_meta",
                  status: "COMPLETED",
                },
              },
            },
            id: "evt_no_meta",
            type: "payment.updated",
          });
          expect(result).toBe("skip");
        },
      );
    });

    test("handles flat listing object without payment wrapper", async () => {
      await withMocks(
        () => stub(squareApi, "retrieveOrder", () => Promise.resolve(null)),
        async (mockOrder) => {
          const result = await squarePaymentProvider.resolveWebhookSession({
            data: {
              object: {
                id: "pay_flat",
                order_id: "order_flat",
                status: "COMPLETED",
              },
            },
            id: "evt_flat",
            type: "payment.updated",
          });
          expect(mockOrder.calls[0]!.args[0]).toBe("order_flat");
          expect(result).toBe("skip");
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
