import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { spy, stub } from "@std/testing/mock";
import type { RefundPaymentInput } from "#shared/square.ts";
import { squareApi } from "#shared/square.ts";
import { withSquareClient } from "#test/lib/square/fixtures.ts";
import { describeSquare } from "#test/lib/square/harness.ts";
import { withMocks } from "#test-utils/mocks.ts";

describeSquare(() => {
  describe("refundPayment", () => {
    test("returns false when access token not set", async () => {
      const result = await squareApi.refundPayment("pay_123");
      expect(result).toBe(false);
    });

    test("returns false when the client is unavailable for the refund POST", async () => {
      // retrievePayment succeeds (payment has an amount), but the client cache
      // returns null at refund time (e.g. settings changed between the two
      // calls — an edge case the guard handles safely by returning false).
      const retrieveStub = stub(squareApi, "retrievePayment", () =>
        Promise.resolve({
          amountMoney: { amount: BigInt(1500), currency: "USD" },
          id: "pay_no_client",
          status: "COMPLETED",
        }),
      );
      await withMocks(
        () => ({ retrieveStub }),
        async () => {
          const result = await squareApi.refundPayment("pay_no_client");
          expect(result).toBe(false);
        },
      );
    });

    test("returns false when payment retrieval returns null", async () => {
      const retrieveStub = stub(squareApi, "retrievePayment", () =>
        Promise.resolve(null),
      );
      const errorSpy = spy(console, "error");
      await withMocks(
        () => ({ errorSpy, retrieveStub }),
        async () => {
          const result = await squareApi.refundPayment("pay_123");
          expect(result).toBe(false);
          // Prove we reached the null-retrieval branch, not an earlier exit.
          expect(retrieveStub.calls).toHaveLength(1);
          expect(retrieveStub.calls[0]!.args[0]).toBe("pay_123");
          expect(errorSpy.calls).toHaveLength(1);
          expect(errorSpy.calls[0]!.args[0]).toBe(
            '[Error] E_SQUARE_REFUND detail="Cannot refund payment pay_123: missing amount info"',
          );
        },
      );
    });

    test("calls SDK refund with correct amount from payment", async () => {
      await withSquareClient(
        {
          paymentsGet: () =>
            Promise.resolve({
              payment: {
                amountMoney: { amount: BigInt(4200), currency: "USD" },
                id: "pay_refund_me",
                orderId: "order_refund",
                status: "COMPLETED",
              },
            }),
          refundsRefundPayment: () =>
            Promise.resolve({
              refund: {
                amount_money: { amount: 4200, currency: "USD" },
                id: "refund_123",
                payment_id: "pay_refund_me",
                status: "COMPLETED",
              },
            }),
        },
        async ({ paymentsGet, refundsRefundPayment }) => {
          const result = await squareApi.refundPayment("pay_refund_me");
          expect(result).toBe(true);

          expect(paymentsGet.calls[0]!.args[0]).toEqual({
            paymentId: "pay_refund_me",
          });

          const refundArgs = refundsRefundPayment.calls[0]
            ?.args[0] as RefundPaymentInput;
          expect(refundArgs.paymentId).toBe("pay_refund_me");
          expect(refundArgs.amountMoney.amount).toBe(BigInt(4200));
          expect(refundArgs.amountMoney.currency).toBe("USD");
          expect(refundArgs.idempotencyKey).toBe(
            "94jKDa73RqRmoCUbDHE2CCc5rNAMtKDdSERbYIImwK0",
          );
        },
      );
    });

    test("reuses the same idempotency key across repeated refunds of one payment", async () => {
      await withSquareClient(
        {
          paymentsGet: () =>
            Promise.resolve({
              payment: {
                amountMoney: { amount: BigInt(1000), currency: "GBP" },
                id: "pay_repeat",
                orderId: "order_repeat",
                status: "COMPLETED",
              },
            }),
          refundsRefundPayment: () =>
            Promise.resolve({
              refund: {
                amount_money: { amount: 1000, currency: "GBP" },
                id: "refund_repeat",
                payment_id: "pay_repeat",
                status: "PENDING",
              },
            }),
        },
        async ({ refundsRefundPayment }) => {
          await squareApi.refundPayment("pay_repeat");
          await squareApi.refundPayment("pay_repeat");

          expect(refundsRefundPayment.calls).toHaveLength(2);
          const [first, second] = refundsRefundPayment.calls.map(
            (call) => (call.args[0] as RefundPaymentInput).idempotencyKey,
          );
          expect(first).toBe(second);
          expect(first).toBe("Zo9WnE2h_fa7qTOrXREnPmK-WsI5dcg2LE4-0mMYwao");
        },
      );
    });

    test("returns false when refund SDK call throws", async () => {
      await withSquareClient(
        {
          paymentsGet: () =>
            Promise.resolve({
              payment: {
                amountMoney: { amount: BigInt(1000), currency: "GBP" },
                id: "pay_fail",
                orderId: "order_fail",
                status: "COMPLETED",
              },
            }),
          refundsRefundPayment: () =>
            Promise.reject(new Error("Status code: 500 Body: ...")),
        },
        async () => {
          const result = await squareApi.refundPayment("pay_fail");
          expect(result).toBe(false);
        },
      );
    });

    test("re-throws a SyntaxError (invalid JSON in a 200 body)", async () => {
      // A 200 with invalid JSON is a malformed provider response — it must
      // propagate (fail loudly), not be caught as a generic error → false.
      await withSquareClient(
        {
          paymentsGet: () =>
            Promise.resolve({
              payment: {
                amountMoney: { amount: BigInt(1000), currency: "GBP" },
                id: "pay_bad_json",
                orderId: "order_bad_json",
                status: "COMPLETED",
              },
            }),
          refundsRefundPayment: () =>
            Promise.reject(new SyntaxError("Unexpected token <")),
        },
        async () => {
          await expect(squareApi.refundPayment("pay_bad_json")).rejects.toThrow(
            SyntaxError,
          );
        },
      );
    });

    /** Runs refundPayment against a payment with a chargeable amount, with a
     * valid Square refund object. `payment_id` and `amount_money` default to
     * the expected values (matching the payment). Returns the boolean outcome,
     * so each status case only states its id + status + expectation. */
    const refundOutcomeFor = async (refund: {
      id: string;
      status: string;
      payment_id?: string;
      amount_money?: { amount: number; currency: string };
    }): Promise<boolean> => {
      const paymentId = "pay_contract";
      let outcome = true;
      await withSquareClient(
        {
          paymentsGet: () =>
            Promise.resolve({
              payment: {
                amountMoney: { amount: BigInt(1999), currency: "GBP" },
                id: paymentId,
                orderId: "order_contract",
                status: "COMPLETED",
              },
            }),
          refundsRefundPayment: () =>
            Promise.resolve({
              refund: {
                amount_money: { amount: 1999, currency: "GBP" },
                payment_id: paymentId,
                ...refund,
              },
            }),
        },
        async () => {
          outcome = await squareApi.refundPayment(paymentId);
        },
      );
      return outcome;
    };

    test("returns true for a COMPLETED refund status", async () => {
      expect(
        await refundOutcomeFor({ id: "ref_completed", status: "COMPLETED" }),
      ).toBe(true);
    });

    test("throws when the refund is for a different payment", async () => {
      await expect(
        refundOutcomeFor({
          id: "ref_wrong_payment",
          payment_id: "pay_some_other",
          status: "COMPLETED",
        }),
      ).rejects.toThrow("pay_some_other");
    });

    test("returns false for a PENDING refund status", async () => {
      expect(
        await refundOutcomeFor({ id: "ref_pending", status: "PENDING" }),
      ).toBe(false);
    });

    test("returns false for a FAILED refund status", async () => {
      expect(
        await refundOutcomeFor({ id: "ref_failed", status: "FAILED" }),
      ).toBe(false);
    });

    test("returns false for a REJECTED refund status", async () => {
      expect(
        await refundOutcomeFor({ id: "ref_rejected", status: "REJECTED" }),
      ).toBe(false);
    });

    test("throws for an APPROVED status (not a PaymentRefund status)", async () => {
      // APPROVED is in Square's RefundStatus ENUM but NOT the PaymentRefund
      // object's status field. The picklist rejects undocumented statuses.
      await expectMalformedThrows({
        refund: { id: "ref_approved", status: "APPROVED" },
      });
    });

    test("throws for a SUCCEEDED status (not a Square refund status)", async () => {
      await expectMalformedThrows({
        refund: { id: "ref_succeeded", status: "SUCCEEDED" },
      });
    });

    test("throws for an unknown refund status", async () => {
      await expectMalformedThrows({
        refund: { id: "ref_unknown", status: "WAT" },
      });
    });

    test("accepts a 1-character id (minLength boundary)", async () => {
      // A 1-char id is the documented minimum (Square: Min Length 1). This
      // catches a minLength(1)→minLength(2) mutant that would reject it.
      expect(await refundOutcomeFor({ id: "r", status: "PENDING" })).toBe(
        false,
      );
    });

    /** Runs refundPayment with a malformed Square refund response, expecting
     *  the Valibot boundary schema to throw loudly (outside withClient). */
    const expectMalformedThrows = async (raw: unknown): Promise<void> => {
      const paymentId = "pay_malformed";
      await withSquareClient(
        {
          paymentsGet: () =>
            Promise.resolve({
              payment: {
                amountMoney: { amount: BigInt(1500), currency: "USD" },
                id: paymentId,
                orderId: "order_malformed",
                status: "COMPLETED",
              },
            }),
          refundsRefundPayment: () => Promise.resolve(raw),
        },
        async () => {
          // A malformed response throws (ValiError from v.parse) OUTSIDE
          // withClient — it fails loudly instead of normalizing to false.
          await expect(squareApi.refundPayment(paymentId)).rejects.toThrow();
        },
      );
    };

    test("throws when the response has no refund object", async () => {
      await expectMalformedThrows({});
    });

    test("throws when the refund object has no id", async () => {
      await expectMalformedThrows({ refund: { status: "COMPLETED" } });
    });

    test("throws when the refund id is an empty string", async () => {
      await expectMalformedThrows({ refund: { id: "", status: "PENDING" } });
    });

    test("throws when the refund object has no status", async () => {
      await expectMalformedThrows({ refund: { id: "ref_no_status" } });
    });

    test("throws when the refund id is a non-string type", async () => {
      await expectMalformedThrows({ refund: { id: 123, status: "COMPLETED" } });
    });
  });
});
