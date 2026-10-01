import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import type { ProviderRead } from "#payment/provider-read.ts";
import { PaymentUserError } from "#shared/payment-helpers.ts";
import { squareApi } from "#shared/square/api.ts";
import type { SquarePayment } from "#shared/square/wire.ts";
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

/** A Square order in the given state with no tenders, and one payment read
 * that names itself: the shape the canceled-order and unreadable-payment
 * reads share. Runs the body with both stubs live, restoring them after. */
const withOrderAndPayment = async (
  orderId: string,
  state: string,
  payment: SquarePayment,
  run: () => Promise<void>,
): Promise<void> => {
  const order = stub(squareApi, "readOrder", () =>
    Promise.resolve(
      squareOrderRead({
        id: orderId,
        metadata: SQUARE_ORDER_META,
        state,
        tenders: [],
        totalMoney: squareMoney(1000),
      }),
    ),
  );
  const read = stub(squareApi, "readPayment", () =>
    Promise.resolve(
      foundPayment({
        amountMoney: squareMoney(1000),
        ...payment,
      } as SquarePayment),
    ),
  );
  try {
    await run();
  } finally {
    order.restore();
    read.restore();
  }
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

  describe("resolveWebhookSession", () => {
    test("skips a non-completed payment and says so in the log", async () => {
      const result = await squarePaymentProvider.resolveWebhookSession({
        data: { object: { id: "pay_1", status: "PENDING" } },
        id: "evt_1",
        type: "payment.updated",
      });
      expect(result).toBe("skip");
      expect(debug().calls.at(-1)?.args).toEqual([
        "[Square] Skipping webhook for non-completed payment (status=PENDING)",
      ]);
    });
  });

  describe("retrieveSession canceled order", () => {
    test("logs a foreign-metadata order and reads no session from it", async () => {
      using _order = stub(squareApi, "readOrder", () =>
        Promise.resolve(
          squareOrderRead({
            id: "order_foreign",
            metadata: {},
            state: "COMPLETED",
            tenders: [],
            totalMoney: squareMoney(1000),
          }),
        ),
      );
      expect(
        await squarePaymentProvider.retrieveSession("order_foreign"),
      ).toBeNull();
      expect(debug().calls.at(-1)?.args).toEqual([
        "[Square] Square order does not carry app metadata",
      ]);
    });

    test("skips a foreign-metadata webhook order instead of retrying it", async () => {
      using _order = stub(squareApi, "readOrder", () =>
        Promise.resolve(
          squareOrderRead({
            id: "order_foreign_hook",
            metadata: {},
            state: "COMPLETED",
            tenders: [{ id: "tender_1", paymentId: "pay_1" }],
            totalMoney: squareMoney(1000),
          }),
        ),
      );
      expect(
        await squarePaymentProvider.retrieveSession(
          "order_foreign_hook",
          "pay_1",
        ),
      ).toBeNull();
      expect(debug().calls.at(-1)?.args).toEqual([
        "[Square] Square order does not carry app metadata",
      ]);
    });

    test("raises a completed webhook order whose metadata is malformed", async () => {
      using _order = stub(squareApi, "readOrder", () =>
        Promise.resolve(
          squareOrderRead({
            id: "order_malformed",
            metadata: { _origin: "square" },
            state: "COMPLETED",
            tenders: [{ id: "tender_1", paymentId: "pay_1" }],
            totalMoney: squareMoney(1000),
          }),
        ),
      );
      await expect(
        squarePaymentProvider.retrieveSession("order_malformed", "pay_1"),
      ).rejects.toThrow("Completed Square order is missing required metadata");
    });

    test("logs a malformed-metadata order it cannot read", async () => {
      using _order = stub(squareApi, "readOrder", () =>
        Promise.resolve(
          squareOrderRead({
            id: "order_malformed_organic",
            metadata: { _origin: "square" },
            state: "COMPLETED",
            tenders: [],
            totalMoney: squareMoney(1000),
          }),
        ),
      );
      expect(
        await squarePaymentProvider.retrieveSession("order_malformed_organic"),
      ).toBeNull();
      expect(debug().calls.at(-1)?.args).toEqual([
        "[Square] Square order is missing required metadata fields",
      ]);
    });

    test("reads a canceled order as failed, not unpaid", async () => {
      await withOrderAndPayment(
        "order_canceled",
        "CANCELED",
        { id: "pay_1", status: "PENDING" },
        async () => {
          const session =
            await squarePaymentProvider.retrieveSession("order_canceled");
          expect(asSession(session).paymentStatus).toBe("failed");
        },
      );
    });

    test("refuses a payment that reports another order", async () => {
      using _order = stub(squareApi, "readOrder", () =>
        Promise.resolve(
          squareOrderRead({
            id: "order_mine",
            metadata: SQUARE_ORDER_META,
            state: "COMPLETED",
            tenders: [{ id: "tender_1", paymentId: "pay_1" }],
            totalMoney: squareMoney(1000),
          }),
        ),
      );
      using _payment = stub(squareApi, "readPayment", () =>
        Promise.resolve(
          foundPayment({
            amountMoney: squareMoney(1000),
            id: "pay_1",
            orderId: "order_other",
            status: "COMPLETED",
          }),
        ),
      );
      await expect(
        squarePaymentProvider.retrieveSession("order_mine"),
      ).rejects.toThrow("Square payment reports a different order");
    });

    test("raises a webhook whose completed payment names a missing order", async () => {
      using _order = stub(squareApi, "readOrder", () =>
        Promise.resolve(squareOrderRead(null)),
      );
      await expect(
        squarePaymentProvider.retrieveSession("order_missing", "pay_gone"),
      ).rejects.toThrow(
        "Square order is not readable yet for a completed payment",
      );
    });

    test("raises a completed webhook payment that names no order", async () => {
      await expect(
        squarePaymentProvider.resolveWebhookSession({
          data: { object: { id: "pay_1", status: "COMPLETED" } },
          id: "evt_1",
          type: "payment.updated",
        }),
      ).rejects.toThrow("Completed Square payment is missing order id");
    });

    test("raises a webhook payment that names no status", async () => {
      await expect(
        squarePaymentProvider.resolveWebhookSession({
          data: { object: { id: "pay_1" } },
          id: "evt_1",
          type: "payment.updated",
        }),
      ).rejects.toThrow("Square payment webhook is missing status");
    });

    test("reads a webhook that is not a payment as nothing to do", async () => {
      expect(
        await squarePaymentProvider.resolveWebhookSession({
          data: { object: {} },
          id: "evt_1",
          type: "refund.updated",
        }),
      ).toBeNull();
    });

    test("skips a one-character payment id without reading Square", async () => {
      const result = await squarePaymentProvider.resolveWebhookSession({
        data: { object: { id: "p", status: "PENDING" } },
        id: "evt_1",
        type: "payment.updated",
      });
      expect(result).toBe("skip");
    });

    test("raises a webhook payment that names no payment id", async () => {
      await expect(
        squarePaymentProvider.resolveWebhookSession({
          data: { object: { order_id: "order_1", status: "COMPLETED" } },
          id: "evt_1",
          type: "payment.updated",
        }),
      ).rejects.toThrow("Square payment webhook is missing id");
    });

    test("says a webhook payment Square will not reread is unreadable", async () => {
      using _order = stub(squareApi, "readOrder", () =>
        Promise.resolve(
          squareOrderRead({
            id: "order_gone",
            metadata: SQUARE_ORDER_META,
            state: "COMPLETED",
            tenders: [],
            totalMoney: squareMoney(1000),
          }),
        ),
      );
      using _payment = stub(squareApi, "readPayment", () =>
        Promise.resolve(squareOrderRead(null) as never),
      );
      await expect(
        squarePaymentProvider.retrieveSession("order_gone", "pay_gone"),
      ).rejects.toThrow(
        "Square payment did not read back as completed (status=unreadable)",
      );
    });

    test("reports a blank status as blank, not unreadable", async () => {
      await withOrderAndPayment(
        "order_blank",
        "COMPLETED",
        { id: "pay_blank", status: "" },
        async () => {
          await expect(
            squarePaymentProvider.retrieveSession("order_blank", "pay_blank"),
          ).rejects.toThrow(
            "Square payment did not read back as completed (status=)",
          );
        },
      );
    });
  });

  describe("setupWebhookEndpoint", () => {
    test("refuses with the manual-setup instruction", async () => {
      const result = await squarePaymentProvider.setupWebhookEndpoint(
        "signing_secret",
        "https://example.com/hooks/square",
      );
      expect(result).toEqual({
        error:
          "Square webhooks must be configured manually in the Square Developer Dashboard",
        success: false,
      });
    });
  });

  describe("readCharge", () => {
    test("reads a completed payment's charge money", async () => {
      using _payment = stub(squareApi, "readPayment", () =>
        Promise.resolve(
          foundPayment({
            amountMoney: squareMoney(1000),
            id: "pay_1",
            refundedMoney: squareMoney(200),
            status: "COMPLETED",
          }),
        ),
      );
      expect(await squarePaymentProvider.readCharge("pay_1")).toEqual({
        resource: {
          captured: { amount: 1000, currency: "GBP" },
          confirmedRefunded: { amount: 200, currency: "GBP" },
          refunds: [],
        },
        status: "found",
      });
    });

    test("refuses a payment Square has not completed", async () => {
      using _payment = stub(squareApi, "readPayment", () =>
        Promise.resolve(
          foundPayment({
            amountMoney: squareMoney(1000),
            id: "pay_2",
            status: "PENDING",
          }),
        ),
      );
      expect(await squarePaymentProvider.readCharge("pay_2")).toEqual({
        reason: "unsupported_status",
        status: "invalid",
      });
    });
  });
});
