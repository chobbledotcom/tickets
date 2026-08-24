import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import type { ProviderRead } from "#payment/provider-read.ts";
import { PaymentUserError } from "#shared/payment-helpers.ts";
import { squareApi } from "#shared/square/api.ts";
import type { SquarePayment } from "#shared/square/payment-outcomes.ts";
import { squarePaymentProvider } from "#shared/square-provider.ts";
import { testListing } from "#test-utils/factories.ts";
import { withMocks } from "#test-utils/mocks.ts";
import {
  asSession,
  BLANK_SESSION_METADATA,
} from "#test-utils/payment-session.ts";
import {
  SQUARE_ORDER_META,
  setupSquareProviderSuite,
  squareMoney,
} from "#test-utils/square/fixtures.ts";
import { squareOrderRead } from "#test-utils/square/outcomes.ts";

const foundPayment = (
  resource: SquarePayment,
): ProviderRead<SquarePayment> => ({ resource, status: "found" });

/** Order and payment reads for a paid (pay_1/COMPLETED) order. */
const paidPay1Mocks = (id: string, createdAt?: string) => ({
  order: stub(squareApi, "readOrder", () =>
    Promise.resolve(
      squareOrderRead({
        ...(createdAt ? { createdAt } : {}),
        id,
        metadata: SQUARE_ORDER_META,
        state: "COMPLETED",
        tenders: [{ id: "tender_1", paymentId: "pay_1" }],
        totalMoney: squareMoney(1000),
      }),
    ),
  ),
  payment: stub(squareApi, "readPayment", () =>
    Promise.resolve(
      foundPayment({
        amountMoney: squareMoney(1000),
        id: "pay_1",
        status: "COMPLETED",
      }),
    ),
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
  });

  describe("retrieveSession", () => {
    test("logs and returns null when the order does not exist", async () => {
      await withMocks(
        () =>
          stub(squareApi, "readOrder", () =>
            Promise.resolve(squareOrderRead(null)),
          ),
        async () => {
          expect(
            await squarePaymentProvider.retrieveSession("order_missing"),
          ).toBeNull();
          expect(debug().calls.at(-1)?.args).toEqual([
            "[Square] Square order not found",
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
          order: stub(squareApi, "readOrder", () =>
            Promise.resolve(
              squareOrderRead({
                id: "order_no_total",
                metadata: SQUARE_ORDER_META,
                state: "COMPLETED",
                tenders: [{ id: "tender_1", paymentId: "pay_1" }],
                totalMoney: { amount: null, currency: null },
              }),
            ),
          ),
          payment: stub(squareApi, "readPayment", () =>
            Promise.resolve(foundPayment({ id: "pay_1", status: "COMPLETED" })),
          ),
        }),
        async () => {
          expect(
            await squarePaymentProvider.retrieveSession("order_no_total"),
          ).toEqual({
            metadata: { ...BLANK_SESSION_METADATA, ...SQUARE_ORDER_META },
            paymentReference: "pay_1",
            provider: "square",
            reason: "malformed_charge",
            refundable: true,
            sessionId: "order_no_total",
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
          expect(asSession(result).provider).toBe("square");
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
          order: stub(squareApi, "readOrder", () =>
            Promise.resolve(
              squareOrderRead({
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
          ),
          payment: stub(squareApi, "readPayment", () =>
            Promise.resolve(
              foundPayment({
                amountMoney: squareMoney(1000),
                id: "pay_2",
                status: "COMPLETED",
              }),
            ),
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
          order: stub(squareApi, "readOrder", () =>
            Promise.resolve(
              squareOrderRead({
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
          ),
          payment: stub(squareApi, "readPayment", () =>
            Promise.resolve(
              foundPayment({
                id: "pay_3",
                status: "PENDING",
              }),
            ),
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
          stub(squareApi, "readOrder", () =>
            Promise.resolve(
              squareOrderRead({
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

    test("propagates generic createPaymentLink errors", async () => {
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
          await expect(
            squarePaymentProvider.createCheckoutSession(
              intent,
              "http://localhost",
            ),
          ).rejects.toThrow("Network failure");
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
});
