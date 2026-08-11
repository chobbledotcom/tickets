import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import type { ChargeMoney } from "#shared/payment/resources.ts";
import { PaymentUserError } from "#shared/payment-helpers.ts";
import { squareApi } from "#shared/square.ts";
import { squarePaymentProvider } from "#shared/square-provider.ts";
import {
  SQUARE_ORDER_META,
  setupSquareProviderSuite,
  squareMoney,
} from "#test/test-utils/square/fixtures.ts";
import { testListing } from "#test-utils/factories.ts";
import { withMocks } from "#test-utils/mocks.ts";
import {
  asSession,
  BLANK_SESSION_METADATA,
} from "#test-utils/payment-session.ts";
import { gbp } from "#test-utils/payment-state.ts";

/** A completed order carrying no metadata (the "ignore" fixture). */
const NO_META_ORDER = {
  id: "order_no_meta",
  metadata: {},
  state: "COMPLETED",
  totalMoney: squareMoney(1000),
};

type SquarePayment = Awaited<ReturnType<typeof squareApi.retrievePayment>>;

/** retrieveOrder + retrievePayment stubs for a paid (pay_1/COMPLETED) order. */
const paidPay1Mocks = (id: string, createdAt?: string) => ({
  order: stub(squareApi, "retrieveOrder", () =>
    Promise.resolve({
      ...(createdAt ? { createdAt } : {}),
      id,
      metadata: SQUARE_ORDER_META,
      state: "COMPLETED",
      tenders: [{ id: "tender_1", paymentId: "pay_1" }],
      totalMoney: squareMoney(1000),
    }),
  ),
  payment: stub(squareApi, "retrievePayment", () =>
    Promise.resolve({
      amountMoney: squareMoney(1000),
      id: "pay_1",
      status: "COMPLETED",
    }),
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
  const debug = setupSquareProviderSuite();

  test("declares its webhook contract", () => {
    expect(squarePaymentProvider.checkoutCompletedEventType).toBe(
      "payment.updated",
    );
    expect(squarePaymentProvider.requiresWebhookSignature).toBe(true);
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
          expect(debug().calls.at(-1)?.args).toEqual([
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
          expect(debug().calls.at(-1)?.args).toEqual([
            "[Square] Order order_missing not found",
          ]);
        },
      );
    });

    test("hands a paid order with no total to the refund path", async () => {
      // Square answered without a money object. Number(null) would read as a
      // real free order, so the halves stay null and the boundary refuses the
      // charge — leaving the captured payment refundable rather than booked.
      await withMocks(
        () => ({
          order: stub(squareApi, "retrieveOrder", () =>
            Promise.resolve({
              id: "order_no_total",
              metadata: SQUARE_ORDER_META,
              state: "COMPLETED",
              tenders: [{ id: "tender_1", paymentId: "pay_1" }],
              totalMoney: { amount: null, currency: null },
            }),
          ),
          payment: stub(squareApi, "retrievePayment", () =>
            Promise.resolve({ id: "pay_1", status: "COMPLETED" }),
          ),
        }),
        async () => {
          expect(
            await squarePaymentProvider.retrieveSession("order_no_total"),
          ).toEqual({
            metadata: { ...BLANK_SESSION_METADATA, ...SQUARE_ORDER_META },
            paymentReference: "pay_1",
            reason: "malformed_charge",
            refundable: true,
          });
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
          expect(asSession(result).paymentStatus).toBe("paid");
          expect(asSession(result).paymentReference).toBe("pay_1");
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
          expect(asSession(result).createdAt).toBe("2026-06-20T09:00:00.000Z");
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
              totalMoney: { amount: BigInt(1000), currency: "GBP" },
            }),
          ),
          payment: stub(squareApi, "retrievePayment", () =>
            Promise.resolve({
              amountMoney: squareMoney(1000),
              id: "pay_2",
              status: "COMPLETED",
            }),
          ),
        }),
        async (mocks) => {
          const result =
            await squarePaymentProvider.retrieveSession("order_open");
          expect(result).not.toBeNull();
          expect(asSession(result).paymentStatus).toBe("paid");
          expect(asSession(result).paymentReference).toBe("pay_2");
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
              totalMoney: { amount: BigInt(1000), currency: "GBP" },
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
          expect(asSession(result).paymentStatus).toBe("unpaid");
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
              totalMoney: { amount: BigInt(1000), currency: "GBP" },
            }),
          ),
        async () => {
          const result =
            await squarePaymentProvider.retrieveSession("order_no_tenders");
          expect(result).not.toBeNull();
          expect(asSession(result).paymentReference).toBe("");
          expect(asSession(result).paymentStatus).toBe("unpaid");
        },
      );
    });
  });

  describe("readChargeMoneyOrNull", () => {
    const REFUND_CASES: {
      name: string;
      payment: SquarePayment;
      expected: ChargeMoney | null;
      id?: string;
    }[] = [
      {
        expected: {
          captured: gbp(1000),
          confirmedRefunded: gbp(1000),
          refunds: [],
        },
        name: "reports every penny back when fully refunded",
        payment: {
          amountMoney: squareMoney(1000),
          id: "pay_123",
          refundedMoney: squareMoney(1000),
          status: "COMPLETED",
        },
      },
      {
        expected: {
          captured: gbp(1000),
          confirmedRefunded: gbp(400),
          refunds: [],
        },
        name: "reports the part that went back on a partial refund",
        payment: {
          amountMoney: squareMoney(1000),
          id: "pay_123",
          refundedMoney: squareMoney(400),
          status: "COMPLETED",
        },
      },
      {
        // Square leaves the refunded total off when nothing has gone back, so
        // an absent one is a stated zero rather than a missing fact.
        expected: {
          captured: gbp(1000),
          confirmedRefunded: gbp(0),
          refunds: [],
        },
        name: "reads an absent refunded total as nothing back",
        payment: {
          amountMoney: squareMoney(1000),
          id: "pay_123",
          status: "COMPLETED",
        },
      },
      {
        expected: null,
        name: "refuses a payment whose charged amount is unknown",
        payment: {
          id: "pay_123",
          refundedMoney: squareMoney(1000),
          status: "COMPLETED",
        },
      },
      {
        expected: null,
        id: "pay_missing",
        name: "refuses a payment that cannot be found",
        payment: null,
      },
      {
        // The refund total is THERE but names no amount. Reading that as zero
        // would tell the guard nothing has gone back, and a full refund would
        // be sent on top of money that may already be with the buyer.
        expected: null,
        name: "refuses a refunded total that names no amount",
        payment: {
          amountMoney: squareMoney(1000),
          id: "pay_123",
          refundedMoney: { currency: "GBP" },
          status: "COMPLETED",
        },
      },
      {
        // Two currencies cannot be compared, so what came back is unknown.
        expected: null,
        name: "refuses a refunded total in another currency",
        payment: {
          amountMoney: squareMoney(1000),
          id: "pay_123",
          refundedMoney: squareMoney(1000, "USD"),
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
            const result = await squarePaymentProvider.readChargeMoneyOrNull(
              id ?? "pay_123",
            );
            expect(result).toEqual(expected);
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
