import type { PaymentWork } from "#routes/api/webhook-types.ts";
import {
  applyPaymentSessionClaimKeepingLease,
  type RetainedPaymentSessionClaim,
  requirePaymentSessionClaim,
} from "#shared/db/payments/claims.ts";
import { getPaymentSessions } from "#shared/db/payments/sessions.ts";
import type { PaymentSession } from "#shared/db/payments/types.ts";
import { paymentProgress } from "#shared/payment-runtime/progress.ts";
import type { PaymentResolution } from "#shared/payment-state/lifecycle.ts";
import { required } from "#test-utils/required.ts";

type ReadyResolution = Extract<PaymentResolution, { status: "ready" }>;

export const paymentWorkForCompletion = (
  current: RetainedPaymentSessionClaim,
  resolution: ReadyResolution,
): PaymentWork => {
  const charge = required(
    resolution.observation.charges?.[0],
    "a charge on the ready test payment",
  );
  return {
    claim: current.claim,
    intent: current.payment.bookingIntent,
    payment: current.payment,
    resolution,
    session: {
      amountTotal: resolution.observation.providerTotal.amount,
      createdAt: resolution.observation.createdAt,
      id: current.payment.id,
      paymentReference: charge.resource.id,
    },
  };
};

/** A claimed payment the provider has already said is paid for — the state
 *  every "now finish the booking" test starts from. */
export const claimPaymentReadyToFinish = async (
  paymentId: string,
  resolution: ReadyResolution,
  payment: PaymentSession,
): Promise<RetainedPaymentSessionClaim> =>
  applyPaymentSessionClaimKeepingLease(
    await requirePaymentSessionClaim(paymentId, 60_000),
    paymentProgress(payment, {
      nextReconcileAt: Date.now() + 60_000,
      result: resolution,
      resultState: "succeeded",
      state: "processing",
    }),
  );

export const reclaimPaymentWork = async (
  work: PaymentWork,
): Promise<PaymentWork> => {
  const [payment] = await getPaymentSessions([work.payment.id]);
  return {
    ...work,
    claim: await requirePaymentSessionClaim(work.payment.id, 60_000),
    payment: required(payment, "the payment being reclaimed"),
  };
};
