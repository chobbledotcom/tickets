import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { type Spy, spy, stub } from "@std/testing/mock";
import { setEffectiveDomainForTest } from "#shared/config.ts";
import { setSuppressDebugLogs } from "#shared/log-settings.ts";
import { PaymentUserError } from "#shared/payment-helpers.ts";
import { squareApi } from "#shared/square.ts";
import { squarePaymentProvider } from "#shared/square-provider.ts";
import { expectUnpaidSquareSession } from "#test/shared/square/session-assertions.ts";
import { createTestDb, resetDb } from "#test-utils/db.ts";
import { testListing } from "#test-utils/factories.ts";
import { withMocks } from "#test-utils/mocks.ts";

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

/** Stub one Square order and the payment named by its tender. */
const sessionMocks = ({
  createdAt,
  metadata = ORDER_META,
  orderId,
  orderState = "COMPLETED",
  paymentId,
  refundedMoney,
  status,
}: {
  createdAt?: string;
  metadata?: typeof ORDER_META;
  orderId: string;
  orderState?: string;
  paymentId: string;
  refundedMoney?: NonNullable<SquarePayment>["refundedMoney"];
  status: string;
}) => ({
  order: stub(squareApi, "retrieveOrder", () =>
    Promise.resolve({
      ...(createdAt ? { createdAt } : {}),
      id: orderId,
      metadata,
      state: orderState,
      tenders: [{ id: "tender_1", paymentId }],
      totalMoney: money(1000),
    }),
  ),
  payment: stub(squareApi, "retrievePayment", () =>
    Promise.resolve({
      amountMoney: money(1000),
      id: paymentId,
      orderId,
      ...(refundedMoney ? { refundedMoney } : {}),
      status,
    }),
  ),
});

/** retrieveOrder + retrievePayment stubs for a paid (pay_1/COMPLETED) order. */
const paidPay1Mocks = (orderId: string, createdAt?: string) =>
  sessionMocks({
    ...(createdAt ? { createdAt } : {}),
    orderId,
    paymentId: "pay_1",
    status: "COMPLETED",
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
  let debug: Spy;

  beforeEach(async () => {
    await createTestDb();
    setEffectiveDomainForTest("example.com");
    setSuppressDebugLogs(false);
    debug = spy(console, "debug");
  });

  afterEach(() => {
    debug.restore();
    setSuppressDebugLogs(null);
    resetDb();
  });

  test("declares its webhook contract", () => {
    expect(squarePaymentProvider.checkoutWebhookEvents).toEqual({
      completed: "payment.updated",
      expired: null,
    });
    expect(squarePaymentProvider.requiresWebhookSignature).toBe(true);
    expect(squarePaymentProvider.refundRetryMode).toBe("idempotent");
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
          expect(debug.calls.at(-1)?.args).toEqual([
            "[Square] Order order_no_meta missing required metadata fields",
          ]);
        },
      );
    });

    test("logs and returns null when the order does not exist", async () => {
      await withMocks(
        () => stub(squareApi, "retrieveOrder", () => Promise.resolve(null)),
        async () => {
          expect(
            await squarePaymentProvider.retrieveSession("order_missing"),
          ).toBeNull();
          expect(debug.calls.at(-1)?.args).toEqual([
            "[Square] Order order_missing not found",
          ]);
        },
      );
    });

    test("recovery returns paid for one completed tender", async () => {
      await withMocks(
        () => paidPay1Mocks("order_completed"),
        async (mocks) => {
          const result = await squarePaymentProvider.retrieveSession(
            "order_completed",
            "recovery",
          );
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
        () =>
          sessionMocks({
            orderId: "order_open",
            orderState: "OPEN",
            paymentId: "pay_2",
            status: "COMPLETED",
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

    for (const [label, refundedMoney, paymentStatus] of [
      ["partially refunded", money(400), "unpaid"],
      ["refunded in another currency", money(0, "EUR"), "unpaid"],
      ["missing refunded amount", { currency: "GBP" }, "unpaid"],
      ["not refunded", money(0), "paid"],
    ] as const) {
      test(`returns ${paymentStatus} when a completed payment is ${label}`, async () => {
        await withMocks(
          () =>
            sessionMocks({
              orderId: `order_${label}`,
              paymentId: `pay_${label}`,
              refundedMoney,
              status: "COMPLETED",
            }),
          async () => {
            expect(
              await squarePaymentProvider.retrieveSession(`order_${label}`),
            ).toMatchObject({ paymentStatus });
          },
        );
      });
    }

    test("returns unpaid when order state is OPEN and payment is not COMPLETED", async () => {
      await withMocks(
        () =>
          sessionMocks({
            orderId: "order_open",
            paymentId: "pay_3",
            status: "PENDING",
          }),
        () => expectUnpaidSquareSession("order_open", "pay_3"),
      );
    });

    test("recovery returns unpaid when no tenders exist", async () => {
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
          const result = await squarePaymentProvider.retrieveSession(
            "order_no_tenders",
            "recovery",
          );
          expect(result).not.toBeNull();
          expect(result!.paymentStatus).toBe("unpaid");
        },
      );
    });

    test("ignores a tender without a payment id", async () => {
      await withMocks(
        () =>
          stub(squareApi, "retrieveOrder", () =>
            Promise.resolve({
              id: "order_empty_tender",
              metadata: ORDER_META,
              tenders: [{ id: "tender_without_payment" }],
              totalMoney: money(1000),
            }),
          ),
        async () => {
          expect(
            await squarePaymentProvider.retrieveSession("order_empty_tender"),
          ).toMatchObject({ paymentReference: "", paymentStatus: "unpaid" });
        },
      );
    });

    test("uses a completed tender and its actual amount on redirect", async () => {
      await withMocks(
        () => ({
          order: stub(squareApi, "retrieveOrder", () =>
            Promise.resolve({
              id: "order_two_tenders",
              metadata: ORDER_META,
              tenders: [
                { paymentId: "pay_completed" },
                { paymentId: "pay_stale" },
              ],
              totalMoney: money(1000),
            }),
          ),
          payment: stub(squareApi, "retrievePayment", (id) =>
            Promise.resolve(
              id === "pay_stale"
                ? {
                    amountMoney: money(1000),
                    id,
                    orderId: "order_two_tenders",
                    status: "PENDING",
                  }
                : {
                    amountMoney: money(900),
                    id,
                    orderId: "order_two_tenders",
                    status: "COMPLETED",
                  },
            ),
          ),
        }),
        async ({ payment }) => {
          const result = await squarePaymentProvider.retrieveSession(
            "order_two_tenders",
            "callback",
          );
          expect(payment.calls.map((call) => call.args)).toEqual([
            ["pay_stale"],
            ["pay_completed"],
          ]);
          expect(result).toMatchObject({
            amountTotal: 900,
            paymentReference: "pay_completed",
            paymentStatus: "paid",
          });
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
        expected: true,
        name: "returns true when a one-cent payment is fully refunded",
        payment: {
          amountMoney: money(1),
          id: "pay_123",
          refundedMoney: money(1),
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
        () =>
          sessionMocks({
            orderId: "order_nested_456",
            paymentId: "pay_nested_123",
            status: "COMPLETED",
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
          expect(result).not.toBe("retry");
          expect(result).not.toBeNull();
          expect(mocks.order.calls[0]!.args[0]).toBe("order_nested_456");
          expect(mocks.payment.calls[0]!.args[0]).toBe("pay_nested_123");
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
      expect(debug.calls.at(-1)?.args).toEqual([
        "[Square] Skipping webhook for non-completed payment (status=APPROVED)",
      ]);
    });

    test("rejects a payment event without its required identifiers", async () => {
      await expect(
        squarePaymentProvider.resolveWebhookSession({
          data: {
            object: {
              payment: {
                status: "COMPLETED",
              },
            },
          },
          id: "evt_no_id",
          type: "payment.updated",
        }),
      ).rejects.toThrow("Square payment webhook is missing order_id or id");
    });

    test("rejects a payment id without its order id", async () => {
      await expect(
        squarePaymentProvider.resolveWebhookSession({
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
        }),
      ).rejects.toThrow("Square payment webhook is missing order_id or id");
    });

    test("ignores an unrelated event without payment identifiers", async () => {
      expect(
        await squarePaymentProvider.resolveWebhookSession({
          data: {
            object: {},
          },
          id: "evt_refund",
          type: "refund.updated",
        }),
      ).toBeNull();
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

    test("uses the exact webhook payment instead of a stale order tender", async () => {
      await withMocks(
        () => ({
          order: stub(squareApi, "retrieveOrder", () =>
            Promise.resolve({
              id: "order_stale",
              metadata: ORDER_META,
              tenders: [{ paymentId: "pay_stale" }],
              totalMoney: money(1000),
            }),
          ),
          payment: stub(squareApi, "retrievePayment", (id) =>
            Promise.resolve({
              amountMoney: money(900),
              id,
              orderId: "order_stale",
              status: "COMPLETED",
            }),
          ),
        }),
        async ({ payment }) => {
          const result = await squarePaymentProvider.resolveWebhookSession({
            data: {
              object: {
                payment: {
                  id: "pay_webhook",
                  order_id: "order_stale",
                  status: "COMPLETED",
                },
              },
            },
            id: "evt_stale",
            type: "payment.updated",
          });
          expect(payment.calls.map((call) => call.args)).toEqual([
            ["pay_webhook"],
          ]);
          expect(result).toMatchObject({
            amountTotal: 900,
            paymentReference: "pay_webhook",
          });
        },
      );
    });

    test("returns retry when the webhook payment is temporarily absent", async () => {
      await withMocks(
        () => ({
          order: stub(squareApi, "retrieveOrder", () =>
            Promise.resolve({
              id: "order_missing_payment",
              metadata: ORDER_META,
              totalMoney: money(1000),
            }),
          ),
          payment: stub(squareApi, "retrievePayment", () =>
            Promise.resolve(null),
          ),
        }),
        async () => {
          expect(
            await squarePaymentProvider.resolveWebhookSession({
              data: {
                object: {
                  payment: {
                    id: "pay_missing",
                    order_id: "order_missing_payment",
                    status: "COMPLETED",
                  },
                },
              },
              id: "evt_missing_payment",
              type: "payment.updated",
            }),
          ).toBe("retry");
        },
      );
    });

    for (const [name, payment] of [
      [
        "wrong order",
        {
          amountMoney: money(1000),
          id: "pay_wrong_order",
          orderId: "another_order",
          status: "COMPLETED",
        },
      ],
      [
        "missing amount",
        {
          id: "pay_missing_amount",
          orderId: "order_inconsistent",
          status: "COMPLETED",
        },
      ],
    ] as const) {
      test(`returns retry for a completed webhook payment with ${name}`, async () => {
        await withMocks(
          () => ({
            order: stub(squareApi, "retrieveOrder", () =>
              Promise.resolve({
                id: "order_inconsistent",
                metadata: ORDER_META,
                totalMoney: money(1000),
              }),
            ),
            payment: stub(squareApi, "retrievePayment", () =>
              Promise.resolve(payment),
            ),
          }),
          async () => {
            expect(
              await squarePaymentProvider.resolveWebhookSession({
                data: {
                  object: {
                    payment: {
                      id: payment.id,
                      order_id: "order_inconsistent",
                      status: "COMPLETED",
                    },
                  },
                },
                id: `evt_${payment.id}`,
                type: "payment.updated",
              }),
            ).toBe("retry");
          },
        );
      });
    }

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
          expect(result).toBe("retry");
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
