import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { squareApi } from "#shared/square/api.ts";
import { squarePaymentProvider } from "#shared/square-provider.ts";
import { gbp } from "#test-utils/payment-state.ts";
import {
  withSquareAnswer,
  withSquareClient,
} from "#test-utils/square/fixtures.ts";
import { describeSquare } from "#test-utils/square/harness.ts";

describeSquare(() => {
  describe("readPayment", () => {
    test("returns unavailable when access token not set", async () => {
      const result = await squareApi.readPayment("pay_123");
      expect(result).toEqual({
        reason: "not_configured",
        status: "unavailable",
      });
    });

    test("refuses a successful response with no payment", async () => {
      await withSquareClient(
        { paymentsGet: () => Promise.resolve({ payment: null }) },
        async ({ paymentsGet }) => {
          const result = await squareApi.readPayment("pay_missing");
          expect(result).toEqual({
            reason: "missing_documented_resource",
            status: "invalid",
          });
          expect(paymentsGet.calls[0]!.args[0]).toEqual({
            paymentId: "pay_missing",
          });
        },
      );
    });

    // Square leaves the refunded total off a payment nothing has come back on.
    // Building an empty object for it would turn "nothing was refunded" into
    // "Square gave an answer we cannot read", and the refund guard would then
    // withhold every refund on every untouched Square charge.
    test("keeps an absent refunded total absent, so the charge stays readable", async () => {
      await withSquareClient(
        {
          paymentsGet: () =>
            Promise.resolve({
              payment: {
                amountMoney: { amount: BigInt(5000), currency: "GBP" },
                id: "pay_untouched",
                status: "COMPLETED",
              },
            }),
        },
        async () => {
          const payment = await squareApi.readPayment("pay_untouched");
          expect(payment.status).toBe("found");
          if (payment.status !== "found") return;
          expect(payment.resource.refundedMoney).toBeUndefined();

          // ...and the provider reads that as a charge nothing has gone back on,
          // which is what lets a refund be sent at all.
          expect(
            await squarePaymentProvider.readCharge("pay_untouched"),
          ).toEqual({
            resource: {
              captured: gbp(5000),
              confirmedRefunded: gbp(0),
              refunds: [],
            },
            status: "found",
          });
        },
      );
    });

    test("maps payment fields correctly from SDK response", async () => {
      await withSquareClient(
        {
          paymentsGet: () =>
            Promise.resolve({
              payment: {
                amountMoney: {
                  amount: BigInt(5000),
                  currency: "GBP",
                },
                id: "pay_full",
                orderId: "order_999",
                refundedMoney: {
                  amount: BigInt(5000),
                  currency: "GBP",
                },
                status: "COMPLETED",
              },
            }),
        },
        async () => {
          const result = await squareApi.readPayment("pay_full");
          expect(result.status).toBe("found");
          if (result.status !== "found") return;
          expect(result.resource.id).toBe("pay_full");
          expect(result.resource.status).toBe("COMPLETED");
          expect(result.resource.orderId).toBe("order_999");
          expect(result.resource.amountMoney!.amount).toBe(BigInt(5000));
          expect(result.resource.amountMoney!.currency).toBe("GBP");
          expect(result.resource.refundedMoney!.amount).toBe(BigInt(5000));
          expect(result.resource.refundedMoney!.currency).toBe("GBP");
        },
      );
    });
  });

  describe("readPayment money Square only partly states", () => {
    // Square states a money object with both halves or not at all. Reading a
    // half of one as "nothing" would tell the charge boundary a figure Square
    // never gave, so the answer is refused where it arrives.
    test("refuses an amount and currency Square left empty", async () => {
      const read = await withSquareAnswer(
        {
          payment: {
            amount_money: { amount: null, currency: null },
            id: "pay_partial",
            status: "COMPLETED",
          },
        },
        () => squareApi.readPayment("pay_partial"),
      );
      expect(read).toEqual({
        reason: "malformed_response",
        status: "invalid",
      });
    });
  });
});
