import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { setEffectiveDomainForTest } from "#shared/config.ts";
import { PaymentUserError } from "#shared/payment-helpers.ts";
import { squareApi } from "#shared/square.ts";
import { squarePaymentProvider } from "#shared/square-provider.ts";
import { createTestDb, resetDb, testListing, withMocks } from "#test-utils";

/** A Square Money value in the given minor units (defaults to USD). */
const money = (amount: number, currency = "USD") => ({
  amount: BigInt(amount),
  currency,
});

/** The canonical order metadata for a single-ticket Square checkout. */
const ORDER_META = {
  email: "alice@example.com",
  items: '[{"e":1,"q":1,"p":0}]',
  name: "Alice",
};

/** A completed order carrying no metadata (the "ignore" fixture). */
const NO_META_ORDER = {
  id: "order_no_meta",
  metadata: {},
  state: "COMPLETED",
  totalMoney: money(1000),
};

type SquarePayment = Awaited<ReturnType<typeof squareApi.retrievePayment>>;

/** retrieveOrder + retrievePayment stubs for a paid (pay_1/COMPLETED) order. */
const paidPay1Mocks = (id: string, createdAt?: string) => ({
  order: stub(squareApi, "retrieveOrder", () =>
    Promise.resolve({
      ...(createdAt ? { createdAt } : {}),
      id,
      metadata: ORDER_META,
      state: "COMPLETED",
      tenders: [{ id: "tender_1", paymentId: "pay_1" }],
      totalMoney: money(1000),
    }),
  ),
  payment: stub(squareApi, "retrievePayment", () =>
    Promise.resolve({ id: "pay_1", status: "COMPLETED" }),
  ),
});

/** A single-line checkout intent for the given listing and phone value. */
const listingIntent = (
  listing: ReturnType<typeof testListing>,
  phone: string,
) => ({
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
  phone,
  special_instructions: "",
});

/** Assert createCheckoutSession surfaces a thrown PaymentUserError's message. */
const expectCheckoutUserError = async (
  intent: Parameters<typeof squarePaymentProvider.createCheckoutSession>[0],
  message: string,
): Promise<void> => {
  await withMocks(
    () =>
      stub(squareApi, "createPaymentLink", () => {
        throw new PaymentUserError(message);
      }),
    async () => {
      const result = await squarePaymentProvider.createCheckoutSession(
        intent,
        "http://localhost",
      );
      expect(result).not.toBeNull();
      expect(result).toHaveProperty("error");
      expect((result as { error: string }).error).toBe(message);
    },
  );
};

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
            Promise.resolve(NO_META_ORDER),
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
        () => paidPay1Mocks("order_completed"),
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
      // Square timestamps can omit milliseconds; the ledger needs .sssZ.
      await withMocks(
        () => paidPay1Mocks("order_dated", "2026-06-20T09:00:00Z"),
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
    const REFUND_CASES: {
      name: string;
      payment: SquarePayment;
      expected: boolean;
      id?: string;
    }[] = [
      {
        expected: true,
        name: "returns true when fully refunded",
        payment: {
          amountMoney: money(1000),
          id: "pay_123",
          refundedMoney: money(1000),
          status: "COMPLETED",
        },
      },
      {
        expected: false,
        name: "returns false when only partially refunded",
        payment: {
          amountMoney: money(1000),
          id: "pay_123",
          refundedMoney: money(400),
          status: "COMPLETED",
        },
      },
      {
        // Without amountMoney we cannot confirm a full refund, so a present
        // refundedMoney must not be treated as fully refunded.
        expected: false,
        name: "returns false when the charged amount is unknown",
        payment: {
          id: "pay_123",
          refundedMoney: money(1000),
          status: "COMPLETED",
        },
      },
      {
        expected: false,
        name: "returns false when refundedMoney is zero",
        payment: {
          amountMoney: money(1000),
          id: "pay_123",
          refundedMoney: money(0),
          status: "COMPLETED",
        },
      },
      {
        expected: false,
        id: "pay_missing",
        name: "returns false when payment not found",
        payment: null,
      },
      {
        expected: false,
        name: "returns false when refundedMoney is missing",
        payment: {
          amountMoney: money(1000),
          id: "pay_123",
          status: "COMPLETED",
        },
      },
    ];

    for (const { name, payment, expected, id } of REFUND_CASES) {
      test(name, async () => {
        await withMocks(
          () =>
            stub(squareApi, "retrievePayment", () => Promise.resolve(payment)),
          async () => {
            const result = await squarePaymentProvider.isPaymentRefunded(
              id ?? "pay_123",
            );
            expect(result).toBe(expected);
          },
        );
      });
    }
  });

  describe("createCheckoutSession", () => {
    test("returns error result when createPaymentLink throws PaymentUserError", async () => {
      const listing = testListing({
        fields: "email" as const,
        unit_price: 1000,
      });
      await expectCheckoutUserError(
        listingIntent(listing, "bad"),
        "Phone number is invalid",
      );
    });

    test("returns null when createPaymentLink throws a generic error", async () => {
      const listing = testListing({
        fields: "email" as const,
        unit_price: 1000,
      });
      const intent = listingIntent(listing, "");
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
      await expectCheckoutUserError(intent, "Email address is invalid");
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
