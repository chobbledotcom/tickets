import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type {
  RefundAttemptResult,
  RefundRequest,
} from "#shared/payment/refund-attempt.ts";
import { squareApi } from "#shared/square/api.ts";
import {
  SquareApiError,
  SquareConnectionError,
  SquareProtocolError,
} from "#shared/square/transport.ts";
import { withSquareClient } from "#test/test-utils/square/fixtures.ts";
import { describeSquare } from "#test/test-utils/square/harness.ts";
import { squareBoundaryValidationError } from "#test/test-utils/square/outcomes.ts";
import { gbp } from "#test-utils/payment-state.ts";
import { providerRefundHttpCases } from "#test-utils/provider-failure-cases.ts";

const request: RefundRequest = {
  charge: {
    captured: gbp(1000),
    confirmedRefunded: gbp(0),
    refunds: [],
  },
  paymentReference: "pay_failure",
};

const outcomeWhen = async (error: unknown): Promise<RefundAttemptResult> =>
  await withSquareClient(
    { refundsRefundPayment: () => Promise.reject(error) },
    () => squareApi.refundCharge(request),
  );

describeSquare(() => {
  describe("refundCharge failures", () => {
    test("states that no request left when Square is not configured", async () => {
      expect(await squareApi.refundCharge(request)).toEqual({
        kind: "not_sent",
        reason: "not_configured",
      });
    });

    for (const [status, expected] of providerRefundHttpCases) {
      test(`classifies HTTP ${status} without guessing`, async () => {
        expect(
          await outcomeWhen(new SquareApiError(status, "failure")),
        ).toEqual(expected);
      });
    }

    for (const reason of ["network_error", "timeout"] as const) {
      test(`keeps a ${reason} connection failure uncertain`, async () => {
        expect(
          await outcomeWhen(new SquareConnectionError(reason, "offline")),
        ).toEqual({ kind: "uncertain", reason });
      });
    }

    test("names invalid JSON as a malformed response", async () => {
      expect(await outcomeWhen(new SquareProtocolError("bad JSON"))).toEqual({
        kind: "uncertain",
        reason: "malformed_response",
      });
    });

    test("names a boundary validation failure as malformed", async () => {
      expect(await outcomeWhen(squareBoundaryValidationError())).toEqual({
        kind: "uncertain",
        reason: "malformed_response",
      });
    });

    test("does not relabel an unknown internal failure as a network error", async () => {
      await expect(outcomeWhen(new Error("internal bug"))).rejects.toThrow(
        "internal bug",
      );
    });
  });
});
