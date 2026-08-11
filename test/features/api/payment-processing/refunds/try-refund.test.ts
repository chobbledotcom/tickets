// jscpd:ignore-start
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { tryRefund } from "#routes/api/payment-processing/refunds.ts";
import type { TaggedPaymentReference } from "#shared/payment/provider-reference.ts";
import type { RefundAttemptResult } from "#shared/payment/refund-attempt.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { errorLogged, useErrorLogSpy } from "#test-utils/debug-log.ts";
import { chargeMoney, fullyRefundedMoney } from "#test-utils/payment-state.ts";
import {
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

  for (
    const [name, refundSucceeds, alreadyRefunded, expected] of [
      ["refund succeeds", true, false, true],
      ["already refunded", false, true, true],
      ["refund fails", false, false, false],
    ] as const
  ) {
    test(`returns ${expected} when ${name}`, async () => {
      await withRefundMock(
        refundSucceeds,
        async () => {
          expect(
            await tryRefund(
              stripeReference(`pi_${name.replace(/\s/g, "_")}`),
            ),
          ).toBe(expected);
        },
        {
          charge: alreadyRefunded ? fullyRefundedMoney() : chargeMoney(),
        },
      );
    });
  }

  for (
    const [name, result] of [
      [
        "accepted",
        {
          amount: { amount: 1000, currency: "GBP" },
          kind: "accepted",
          proof: {
            charge: chargeMoney(),
            kind: "charge_observation",
          },
        },
      ],
      ["not sent", { kind: "not_sent", reason: "not_configured" }],
      ["uncertain", { kind: "uncertain", reason: "timeout" }],
    ] as const satisfies readonly (readonly [string, RefundAttemptResult])[]
  ) {
    test(`does not call an ${name} refund completed`, async () => {
      await withRefundMock(result, async () => {
        expect(
          await tryRefund(stripeReference(`pi_${result.kind}`)),
        ).toBe(false);
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
