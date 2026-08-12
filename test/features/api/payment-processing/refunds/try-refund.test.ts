// jscpd:ignore-start
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { tryRefund } from "#routes/api/payment-processing/refunds.ts";
import type { TaggedPaymentReference } from "#shared/payment/provider-reference.ts";
import type {
  RefundAttemptResult,
  RefundRequest,
} from "#shared/payment/refund-attempt.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { errorLogged, useErrorLogSpy } from "#test-utils/debug-log.ts";
import { chargeMoney, fullyRefundedMoney } from "#test-utils/payment-state.ts";
import {
  refundCompletes,
  refundIsRejected,
  refundStaysPending,
  withRefreshPaymentMoney,
  withRefundMock,
} from "#test-utils/refund-routes.ts";

// jscpd:ignore-end

describeWithEnv("tryRefund", { db: true }, () => {
  const errorSpy = useErrorLogSpy();
  const stripeReference = (reference: string): TaggedPaymentReference => ({
    kind: "tagged",
    provider: "stripe",
    reference,
  });

  for (const [name, refund, alreadyRefunded, expected] of [
    ["refund succeeds", refundCompletes, false, true],
    ["already refunded", refundIsRejected, true, true],
    ["refund fails", refundIsRejected, false, false],
  ] as const) {
    test(`returns ${expected} when ${name}`, async () => {
      await withRefundMock(
        refund,
        async () => {
          expect(
            await tryRefund(stripeReference(`pi_${name.replace(/\s/g, "_")}`)),
          ).toBe(expected);
        },
        {
          charge: alreadyRefunded ? fullyRefundedMoney() : chargeMoney(),
        },
      );
    });
  }

  const refundNotSent = (
    _request: RefundRequest,
  ): Promise<RefundAttemptResult> =>
    Promise.resolve({ kind: "not_sent", reason: "not_configured" });
  const refundUncertain = (
    _request: RefundRequest,
  ): Promise<RefundAttemptResult> =>
    Promise.resolve({ kind: "uncertain", reason: "timeout" });
  for (const [name, kind, refund] of [
    ["accepted", "accepted", refundStaysPending],
    ["not sent", "not_sent", refundNotSent],
    ["uncertain", "uncertain", refundUncertain],
  ] as const) {
    test(`does not call an ${name} refund completed`, async () => {
      await withRefundMock(refund, async () => {
        expect(await tryRefund(stripeReference(`pi_${kind}`))).toBe(false);
      });
    });
  }

  test("reports a charge only partly returned", async () => {
    await withRefreshPaymentMoney(
      () => Promise.resolve(chargeMoney(1000, 400)),
      async () => {
        expect(await tryRefund(stripeReference("pi_partly_back"))).toBe(false);
      },
    );

    expect(errorLogged(errorSpy, "partial_refund")).toBe(true);
    expect(errorLogged(errorSpy, "an owner needs to look at it")).toBe(true);
  });
});
