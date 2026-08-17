import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { squareApi } from "#shared/square/api.ts";
import { squarePaymentProvider } from "#shared/square-provider.ts";
import { withSquareClient } from "#test/test-utils/square/fixtures.ts";
import { describeSquare } from "#test/test-utils/square/harness.ts";
import { gbp } from "#test-utils/payment-state.ts";

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
    // Square can name a money object while leaving its amount or currency out.
    // Carrying those through as nulls would read as "Square said zero"; absent
    // is the honest answer, and the refund guard treats it as unreadable.
    test("leaves out an amount and currency Square did not give", async () => {
      await withSquareClient(
        {
          paymentsGet: () =>
            Promise.resolve({
              payment: {
                amountMoney: { amount: null, currency: null },
                id: "pay_partial",
                status: "COMPLETED",
              },
            }),
        },
        async () => {
          const result = await squareApi.readPayment("pay_partial");
          expect(result.status).toBe("found");
          if (result.status !== "found") return;
          expect(result.resource.amountMoney).toEqual({
            amount: undefined,
            currency: undefined,
          });
        },
      );
    });
  });
});
