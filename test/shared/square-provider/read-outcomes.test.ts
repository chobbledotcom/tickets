/* jscpd:ignore-start */
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import type { ProviderRead } from "#shared/payment/provider-read.ts";
import type { ChargeMoney } from "#shared/payment/resources.ts";
import { squareApi } from "#shared/square/api.ts";
import type { SquarePayment } from "#shared/square/payment-outcomes.ts";
import { squarePaymentProvider } from "#shared/square-provider.ts";
import {
  SQUARE_ORDER_META,
  setupSquareProviderSuite,
  squareMoney,
} from "#test/test-utils/square/fixtures.ts";
import { squarePaymentRead } from "#test/test-utils/square/outcomes.ts";
import { withMocks } from "#test-utils/mocks.ts";
import { asSession } from "#test-utils/payment-session.ts";
import { gbp } from "#test-utils/payment-state.ts";

/* jscpd:ignore-end */

const order = {
  id: "order_read",
  metadata: SQUARE_ORDER_META,
  state: "OPEN",
  tenders: [{ id: "tender_read", paymentId: "pay_read" }],
  totalMoney: squareMoney(1000),
};

type FailedSquarePaymentRead = Exclude<
  ProviderRead<SquarePayment>,
  { status: "found" }
>;

/** Run a session read with one named Square payment answer. */
const withSessionRead = (
  read: FailedSquarePaymentRead,
  body: () => Promise<void>,
): Promise<void> =>
  withMocks(
    () => ({
      order: stub(squareApi, "retrieveOrder", () => Promise.resolve(order)),
      payment: stub(squareApi, "readPayment", () => Promise.resolve(read)),
    }),
    () => body(),
  );

describe("square-provider read outcomes", () => {
  setupSquareProviderSuite();

  test("treats a genuinely missing payment on an open order as unpaid", async () => {
    await withSessionRead({ status: "missing" }, async () => {
      const result = await squarePaymentProvider.retrieveSession(order.id);
      expect(asSession(result).paymentReference).toBe("pay_read");
      expect(asSession(result).paymentStatus).toBe("unpaid");
    });
  });

  for (const read of [
    { reason: "timeout", status: "unavailable" },
    { reason: "malformed_response", status: "invalid" },
  ] as const) {
    test(`keeps a ${read.status} session read retryable`, async () => {
      await withSessionRead(read, async () => {
        await expect(
          squarePaymentProvider.retrieveSession(order.id),
        ).rejects.toThrow(`${read.status}:${read.reason}`);
      });
    });
  }

  test("keeps a payment whose order contradicts the event retryable", async () => {
    await withMocks(
      () => ({
        order: stub(squareApi, "retrieveOrder", () =>
          Promise.resolve({ ...order, id: "order_mine" }),
        ),
        payment: stub(squareApi, "readPayment", () =>
          Promise.resolve(
            squarePaymentRead({
              amountMoney: squareMoney(1000),
              id: "pay_stranger",
              orderId: "order_someone_else",
              status: "COMPLETED",
            }),
          ),
        ),
      }),
      async () => {
        await expect(
          squarePaymentProvider.retrieveSession("order_mine", "pay_stranger"),
        ).rejects.toThrow("order_someone_else");
      },
    );
  });

  test("keeps a completed event's stale payment read retryable", async () => {
    await withMocks(
      () => ({
        order: stub(squareApi, "retrieveOrder", () =>
          Promise.resolve({ ...order, id: "order_stale" }),
        ),
        payment: stub(squareApi, "readPayment", () =>
          Promise.resolve(
            squarePaymentRead({
              amountMoney: squareMoney(1000),
              id: "pay_stale",
              status: "APPROVED",
            }),
          ),
        ),
      }),
      async () => {
        await expect(
          squarePaymentProvider.retrieveSession("order_stale", "pay_stale"),
        ).rejects.toThrow("pay_stale");
      },
    );
  });

  test("preserves every failed charge read exactly", async () => {
    const reads: FailedSquarePaymentRead[] = [
      { status: "missing" },
      { reason: "rate_limited", status: "unavailable" },
      { reason: "mismatched_id", status: "invalid" },
    ];
    for (const read of reads) {
      await withMocks(
        () => stub(squareApi, "readPayment", () => Promise.resolve(read)),
        async () => {
          expect(await squarePaymentProvider.readCharge("pay_read")).toEqual(
            read,
          );
        },
      );
    }
  });

  describe("readCharge money", () => {
    const cases: {
      name: string;
      payment: ProviderRead<SquarePayment>;
      expected: ProviderRead<ChargeMoney>;
    }[] = [
      {
        expected: {
          resource: {
            captured: gbp(1000),
            confirmedRefunded: gbp(1000),
            refunds: [],
          },
          status: "found",
        },
        name: "reports every penny back when fully refunded",
        payment: squarePaymentRead({
          amountMoney: squareMoney(1000),
          id: "pay_read",
          refundedMoney: squareMoney(1000),
          status: "COMPLETED",
        }),
      },
      {
        expected: {
          resource: {
            captured: gbp(1000),
            confirmedRefunded: gbp(400),
            refunds: [],
          },
          status: "found",
        },
        name: "reports the part that went back on a partial refund",
        payment: squarePaymentRead({
          amountMoney: squareMoney(1000),
          id: "pay_read",
          refundedMoney: squareMoney(400),
          status: "COMPLETED",
        }),
      },
      {
        expected: {
          resource: {
            captured: gbp(1000),
            confirmedRefunded: gbp(0),
            refunds: [],
          },
          status: "found",
        },
        name: "reads an absent refunded total as nothing back",
        payment: squarePaymentRead({
          amountMoney: squareMoney(1000),
          id: "pay_read",
          status: "COMPLETED",
        }),
      },
      {
        expected: { reason: "malformed_money", status: "invalid" },
        name: "refuses a payment whose charged amount is unknown",
        payment: squarePaymentRead({
          id: "pay_read",
          refundedMoney: squareMoney(1000),
          status: "COMPLETED",
        }),
      },
      {
        expected: { reason: "malformed_money", status: "invalid" },
        name: "refuses a refunded total that names no amount",
        payment: squarePaymentRead({
          amountMoney: squareMoney(1000),
          id: "pay_read",
          refundedMoney: { currency: "GBP" },
          status: "COMPLETED",
        }),
      },
      {
        expected: { reason: "mismatched_money", status: "invalid" },
        name: "refuses a refunded total in another currency",
        payment: squarePaymentRead({
          amountMoney: squareMoney(1000),
          id: "pay_read",
          refundedMoney: squareMoney(1000, "USD"),
          status: "COMPLETED",
        }),
      },
      ...(["PENDING", "FAILED"] as const).map((status) => ({
        expected: {
          reason: "unsupported_status" as const,
          status: "invalid" as const,
        },
        name: `refuses a ${status} payment as a captured charge`,
        payment: squarePaymentRead({
          amountMoney: squareMoney(1000),
          id: "pay_read",
          status,
        }),
      })),
    ];

    for (const { name, payment, expected } of cases) {
      test(name, async () => {
        await withMocks(
          () => stub(squareApi, "readPayment", () => Promise.resolve(payment)),
          async () => {
            expect(await squarePaymentProvider.readCharge("pay_read")).toEqual(
              expected,
            );
          },
        );
      });
    }
  });
});
