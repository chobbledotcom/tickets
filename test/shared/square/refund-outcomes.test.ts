import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type {
  RefundAttemptResult,
  RefundRequest,
} from "#shared/payment/refund-attempt.ts";
import { squareApi } from "#shared/square/api.ts";
import type { RefundPaymentInput } from "#shared/square/payment-outcomes.ts";
import { withSquareClient } from "#test/test-utils/square/fixtures.ts";
import { describeSquare } from "#test/test-utils/square/harness.ts";
import { gbp } from "#test-utils/payment-state.ts";

const refundRequest = (
  paymentReference = "pay_refund_me",
  amount = 4200,
): RefundRequest => ({
  charge: {
    captured: gbp(amount),
    confirmedRefunded: gbp(0),
    refunds: [],
  },
  paymentReference,
});

const refundOutcomeFor = async (
  refund: unknown,
  request = refundRequest(),
): Promise<RefundAttemptResult> => {
  let result: RefundAttemptResult = {
    kind: "not_sent",
    reason: "not_configured",
  };
  await withSquareClient(
    { refundsRefundPayment: () => Promise.resolve(refund) },
    async () => {
      result = await squareApi.refundCharge(request);
    },
  );
  return result;
};

const squareRefund = (
  status: "COMPLETED" | "PENDING" | "REJECTED" | "FAILED",
  overrides: Record<string, unknown> = {},
) => ({
  refund: {
    amount_money: { amount: 4200, currency: "GBP" },
    id: `refund_${status.toLowerCase()}`,
    payment_id: "pay_refund_me",
    status,
    ...overrides,
  },
});

describeSquare(() => {
  describe("refundCharge", () => {
    test("uses the admitted charge without reading the payment again", async () => {
      await withSquareClient(
        {
          refundsRefundPayment: () =>
            Promise.resolve({
              refund: {
                amount_money: { amount: 4200, currency: "GBP" },
                id: "refund_123",
                payment_id: "pay_refund_me",
                status: "COMPLETED",
              },
            }),
        },
        async ({ paymentsGet, refundsRefundPayment }) => {
          const result = await squareApi.refundCharge(refundRequest());

          expect(paymentsGet.calls).toHaveLength(0);
          expect(refundsRefundPayment.calls).toHaveLength(1);
          const sent = refundsRefundPayment.calls[0]!
            .args[0] as RefundPaymentInput;
          expect(sent).toEqual({
            amountMoney: { amount: 4200n, currency: "GBP" },
            idempotencyKey: "94jKDa73RqRmoCUbDHE2CCc5rNAMtKDdSERbYIImwK0",
            paymentId: "pay_refund_me",
          });
          expect(result).toEqual({
            amount: gbp(4200),
            kind: "completed",
            proof: {
              kind: "named_refund",
              refund: {
                id: "refund_123",
                kind: "square_refund",
                parentId: "pay_refund_me",
                provider: "square",
              },
            },
          });
        },
      );
    });

    test("reports a named PENDING refund as accepted", async () => {
      expect(await refundOutcomeFor(squareRefund("PENDING"))).toEqual({
        amount: gbp(4200),
        kind: "accepted",
        proof: {
          kind: "named_refund",
          refund: {
            id: "refund_pending",
            kind: "square_refund",
            parentId: "pay_refund_me",
            provider: "square",
          },
        },
      });
    });

    for (const [status, reason] of [
      ["REJECTED", "rejected"],
      ["FAILED", "failed"],
    ] as const) {
      test(`reports ${status} as ${reason}`, async () => {
        expect(await refundOutcomeFor(squareRefund(status))).toEqual({
          kind: "rejected",
          reason,
        });
      });
    }

    test("keeps a refund for another payment uncertain", async () => {
      expect(
        await refundOutcomeFor(
          squareRefund("COMPLETED", { payment_id: "pay_other" }),
        ),
      ).toEqual({ kind: "uncertain", reason: "mismatched_parent" });
    });

    for (const [name, amountMoney] of [
      ["amount", { amount: 4199, currency: "GBP" }],
      ["currency", { amount: 4200, currency: "USD" }],
    ] as const) {
      test(`keeps a refund with the wrong ${name} uncertain`, async () => {
        expect(
          await refundOutcomeFor(
            squareRefund("COMPLETED", { amount_money: amountMoney }),
          ),
        ).toEqual({ kind: "uncertain", reason: "mismatched_money" });
      });
    }

    for (const [name, response] of [
      ["missing refund", {}],
      ["empty id", squareRefund("COMPLETED", { id: "" })],
      ["blank id", squareRefund("COMPLETED", { id: " " })],
      ["unknown status", squareRefund("COMPLETED", { status: "APPROVED" })],
      [
        "unsafe amount",
        squareRefund("COMPLETED", {
          amount_money: {
            amount: Number.MAX_SAFE_INTEGER + 1,
            currency: "GBP",
          },
        }),
      ],
    ] as const) {
      test(`keeps a ${name} answer uncertain`, async () => {
        expect(await refundOutcomeFor(response)).toEqual({
          kind: "uncertain",
          reason: "malformed_response",
        });
      });
    }

    test("reuses the idempotency key for the same payment", async () => {
      await withSquareClient(
        {
          refundsRefundPayment: () => Promise.resolve(squareRefund("PENDING")),
        },
        async ({ refundsRefundPayment }) => {
          await squareApi.refundCharge(refundRequest());
          await squareApi.refundCharge(refundRequest());
          const keys = refundsRefundPayment.calls.map(
            (call) => (call.args[0] as RefundPaymentInput).idempotencyKey,
          );
          expect(keys).toEqual([keys[0], keys[0]]);
        },
      );
    });
  });
});
