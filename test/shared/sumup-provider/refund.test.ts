import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import type { ProviderRead } from "#payment/provider-read.ts";
import type { RefundAttemptResult } from "#payment/refund-attempt.ts";
import {
  type AuthorizedRefundRequest,
  authorizeDurableRefundSend,
} from "#payment/refund-provider-authorization.ts";
import type { ChargeMoney } from "#payment/resources.ts";
import type { SumupRefundSubmission } from "#shared/sumup/failures.ts";
import { sumupApi } from "#shared/sumup.ts";
import { sumupPaymentProvider } from "#shared/sumup-provider.ts";
import {
  chargeMoney,
  chargeMoneyWith,
  foundCharge,
  fullyRefundedMoney,
  gbp,
  refundObservation,
} from "#test-utils/payment-state.ts";

/** How many fresh readings each immediate answer is worth. A send SumUp never
 *  took moved no money, so it needs none; every other answer needs one. */
const FRESH_READINGS = {
  not_sent: 0,
  rejected: 1,
  sent: 1,
  uncertain: 1,
} satisfies Record<SumupRefundSubmission["kind"], number>;

const request = authorizeDurableRefundSend(
  { charge: chargeMoney(1000), paymentReference: "txn_9" },
  {
    capability: "keyless",
    generation: 1,
    identityIndex: "test-refund-index:txn_9:1",
    provider: "sumup",
  },
);

/** The whole £10 on its way back, but not there yet. */
const wholeChargePending = (): ChargeMoney =>
  chargeMoneyWith({
    captured: gbp(1000),
    refunds: [refundObservation({ amount: gbp(1000), status: "pending" })],
  });

/** Send one refund with SumUp answering `submission`, and the fresh reading
 *  that follows it answering `fresh`. */
const refund = async (
  submission: SumupRefundSubmission,
  fresh: ProviderRead<ChargeMoney> = foundCharge(chargeMoney(1000)),
  sent: AuthorizedRefundRequest<"sumup"> = request,
): Promise<RefundAttemptResult> => {
  using read = stub(sumupPaymentProvider, "readCharge", () =>
    Promise.resolve(fresh),
  );
  using send = stub(sumupApi, "refundTransaction", () =>
    Promise.resolve(submission),
  );
  const result = await sumupPaymentProvider.refundCharge(sent);
  expect(send.calls.map((call) => call.args)).toEqual([
    [sent.paymentReference],
  ]);
  expect(read.calls).toHaveLength(FRESH_READINGS[submission.kind]);
  return result;
};

describe("sending a SumUp refund", () => {
  test("refuses another provider's authority before sending", async () => {
    const stripeRequest = authorizeDurableRefundSend(
      { charge: chargeMoney(1000), paymentReference: "txn_9" },
      {
        capability: "keyed",
        generation: 1,
        idempotencyKey: "stripe-test-key",
        identityIndex: "stripe-test-request",
        provider: "stripe",
      },
    );
    using send = stub(sumupApi, "refundTransaction", () =>
      Promise.resolve({ kind: "sent" }),
    );

    await expect(
      sumupPaymentProvider.refundCharge(stripeRequest),
    ).rejects.toThrow("authorization does not permit sumup");
    expect(send.calls).toHaveLength(0);
  });

  test("does not look again after a send SumUp never took", async () => {
    expect(
      await refund({ kind: "not_sent", reason: "not_configured" }),
    ).toEqual({ kind: "not_sent", reason: "not_configured" });
  });

  test("recognises money returned beside a send SumUp refused", async () => {
    const fresh = fullyRefundedMoney(1000);
    expect(
      await refund(
        { kind: "rejected", reason: "rejected" },
        foundCharge(fresh),
      ),
    ).toEqual({
      amount: gbp(1000),
      kind: "completed",
      proof: { charge: fresh, kind: "charge_observation" },
    });
  });

  test("keeps a refusal when nothing has moved since", async () => {
    expect(await refund({ kind: "rejected", reason: "rejected" })).toEqual({
      kind: "rejected",
      reason: "rejected",
    });
  });

  // A refused send did not start the refund on its way, so a pending one
  // belongs to somebody else and cannot be called this send's.
  test("does not credit a refused send with a refund that is on its way", async () => {
    expect(
      await refund(
        { kind: "rejected", reason: "rejected" },
        foundCharge(wholeChargePending()),
      ),
    ).toEqual({ kind: "uncertain", reason: "observed_refund" });
  });

  test("credits a send that left with the refund it started", async () => {
    const fresh = wholeChargePending();
    expect(await refund({ kind: "sent" }, foundCharge(fresh))).toEqual({
      amount: gbp(1000),
      kind: "accepted",
      proof: { charge: fresh, kind: "charge_observation" },
    });
  });
});
