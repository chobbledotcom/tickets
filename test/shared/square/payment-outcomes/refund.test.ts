import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { RefundAttemptResult } from "#payment/refund-attempt.ts";
import type { AuthorizedRefundRequest } from "#payment/refund-provider-authorization.ts";
import { squareApi } from "#shared/square/api.ts";
import type { RefundPaymentInput } from "#shared/square/payment-outcomes.ts";
import type { SquareRefund } from "#shared/square/wire.ts";
import { setupErrorSpy } from "#test-utils/error-spy.ts";
import { gbp } from "#test-utils/payment-state.ts";
import {
  squareRefundRequest,
  withSquareAnswer,
  withSquareClient,
} from "#test-utils/square/fixtures.ts";
import { describeSquare } from "#test-utils/square/harness.ts";

const refundRequest = (
  paymentReference = "pay_refund_me",
  amount = 4200,
  idempotencyKey = `test-refund:${paymentReference}:1`,
): AuthorizedRefundRequest<"square"> =>
  squareRefundRequest(
    {
      charge: {
        captured: gbp(amount),
        confirmedRefunded: gbp(0),
        refunds: [],
      },
      paymentReference,
    },
    idempotencyKey,
  );

const refundOutcomeFor = async (
  refund: { refund: SquareRefund },
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

/** One refund answer, in the shape the client hands the engine. */
const squareRefund = (
  status: SquareRefund["status"],
  overrides: Partial<SquareRefund> = {},
): { refund: SquareRefund } => ({
  refund: {
    amountMoney: { amount: 4200n, currency: "GBP" },
    id: `refund_${status.toLowerCase()}`,
    paymentId: "pay_refund_me",
    status,
    ...overrides,
  },
});

/** One refund answer as Square words it on the wire. */
const squareRefundBody = (overrides: Record<string, unknown> = {}) => ({
  refund: {
    amount_money: { amount: 4200, currency: "GBP" },
    id: "refund_completed",
    payment_id: "pay_refund_me",
    status: "COMPLETED",
    ...overrides,
  },
});

describeSquare(() => {
  const errors = setupErrorSpy();

  describe("refundCharge", () => {
    test("uses the admitted charge without reading the payment again", async () => {
      await withSquareClient(
        {
          refundsRefundPayment: () =>
            Promise.resolve(squareRefund("COMPLETED", { id: "refund_123" })),
        },
        async ({ paymentsGet, refundsRefundPayment }) => {
          const result = await squareApi.refundCharge(
            refundRequest(
              "pay_refund_me",
              4200,
              "persisted-square-generation-one",
            ),
          );

          expect(paymentsGet.calls).toHaveLength(0);
          expect(refundsRefundPayment.calls).toHaveLength(1);
          const sent = refundsRefundPayment.calls[0]!
            .args[0] as RefundPaymentInput;
          expect(sent).toEqual({
            amountMoney: { amount: 4200n, currency: "GBP" },
            idempotencyKey: "persisted-square-generation-one",
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
          squareRefund("COMPLETED", { paymentId: "pay_other" }),
        ),
      ).toEqual({ kind: "uncertain", reason: "mismatched_parent" });
    });

    for (const [name, amountMoney] of [
      ["amount", { amount: 4199n, currency: "GBP" }],
      ["currency", { amount: 4200n, currency: "USD" }],
    ] as const) {
      test(`keeps a refund with the wrong ${name} uncertain`, async () => {
        expect(
          await refundOutcomeFor(squareRefund("COMPLETED", { amountMoney })),
        ).toEqual({ kind: "uncertain", reason: "mismatched_money" });
      });
    }

    // An answer Square words in a way we cannot read leaves the refund
    // uncertain: the money may well have moved, so nothing may call it rejected.
    for (const [name, body] of [
      ["missing refund", {}],
      ["empty id", squareRefundBody({ id: "" })],
      ["blank id", squareRefundBody({ id: " " })],
      ["unknown status", squareRefundBody({ status: "APPROVED" })],
      [
        "unsafe amount",
        squareRefundBody({
          amount_money: {
            amount: Number.MAX_SAFE_INTEGER + 1,
            currency: "GBP",
          },
        }),
      ],
    ] as const) {
      test(`keeps a ${name} answer uncertain`, async () => {
        const outcome = await withSquareAnswer(body, () =>
          squareApi.refundCharge(refundRequest()),
        );
        expect(outcome).toEqual({
          kind: "uncertain",
          reason: "malformed_response",
        });
        // The operator has to see a refund nobody can account for.
        expect(errors.contains("E_SQUARE_REFUND")).toBe(true);
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
