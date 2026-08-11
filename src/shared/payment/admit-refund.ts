/**
 * Whether a refund may be sent, given what the provider says has already
 * happened to the money. Every refund route asks before it calls a provider,
 * so "already back" and "already on its way" stop the call rather than being
 * discovered by making it. Stripe and Square reject a second full refund
 * themselves; SumUp has no idempotency key and would pay twice.
 */

import type { PaymentConflict } from "#shared/payment/conflict.ts";
import type { ObservationOutcome } from "#shared/payment/diagnose.ts";
import { refundOutcomeOf } from "#shared/payment/diagnose.ts";
import type { ChargeMoney } from "#shared/payment/resources.ts";
import type { PaymentProvider } from "#shared/payments.ts";

/** What to do about a refund somebody asked for. Only `send` reaches a
 *  provider; the rest are answers we already have. */
export type RefundAdmission =
  | { issue: PaymentConflict; kind: "refused" }
  | { kind: "already_returned" }
  | { kind: "in_flight" }
  | { kind: "send" }
  | { kind: "unreadable" };

/** The answer for each way a reading can come out settled, listed
 *  exhaustively so a new outcome must say what it does about refunds. */
const ADMISSION_BY_OUTCOME = {
  fully_refunded: { kind: "already_returned" },
  ready: { kind: "send" },
  refund_pending: { kind: "in_flight" },
} as const satisfies Record<
  Exclude<ObservationOutcome, { kind: "conflict" }>["kind"],
  RefundAdmission
>;

/** Turn what a reading came to into what to do about a refund. A problem the
 *  owner has to look at never sends money: paying into a disagreement between
 *  the reading and the booking is how one buyer is paid twice. */
export const admitRefund = (outcome: ObservationOutcome): RefundAdmission =>
  outcome.kind === "conflict"
    ? { issue: outcome.issue, kind: "refused" }
    : ADMISSION_BY_OUTCOME[outcome.kind];

/** An answer that sends no money. */
export type WithheldRefund = Exclude<RefundAdmission, { kind: "send" }>;

/** Why no money was sent, in words for a log line. Only the refusal needs the
 *  problem's name, so the rest read the same wherever they are reported. */
export const admissionReason = (admission: WithheldRefund): string =>
  admission.kind === "refused"
    ? `needs the owner to look at it (${admission.issue.kind})`
    : ADMISSION_REASONS[admission.kind];

const ADMISSION_REASONS = {
  already_returned: "the money is already back",
  in_flight: "a refund is already on its way",
  unreadable: "the provider could not say what the money has done",
} as const satisfies Record<
  Exclude<RefundAdmission, { kind: "refused" } | { kind: "send" }>["kind"],
  string
>;

/**
 * Ask the provider what has become of this charge's money, and answer whether
 * a refund may be sent. A charge it cannot state is never refunded on the hope
 * that it was fine: unreadable evidence and "already back" look identical from
 * here, and only one is safe to send money against.
 *
 * A read that throws is the same answer as one that comes back empty. Catching
 * it here keeps it distinct from a refund CALL that failed — no money was
 * asked for, so the caller may simply try again.
 */
export const admitProviderRefund = async (
  provider: Pick<PaymentProvider, "readChargeMoneyOrNull">,
  paymentReference: string,
): Promise<RefundAdmission> => {
  const charge = await chargeOrNothing(() =>
    provider.readChargeMoneyOrNull(paymentReference),
  );
  return charge === null
    ? { kind: "unreadable" }
    : admitRefund(refundOutcomeOf([charge]));
};

/** A read that fails is a read that said nothing. Takes the read rather than
 *  the provider so a reader that throws before it returns is caught too. */
const chargeOrNothing = async (
  read: () => Promise<ChargeMoney | null>,
): Promise<ChargeMoney | null> => {
  try {
    return await read();
  } catch {
    return null;
  }
};

/** The whole refund mechanism: ask what the money has already done, send more
 *  only if it may be sent, hand back whichever answer fits. The routes phrase
 *  their endings differently but must never differ on WHEN money leaves, so
 *  every step up to the provider call lives here once. */
export const sendRefundIfAdmitted = async <TAnswer>(
  provider: Pick<
    PaymentProvider,
    "readChargeMoneyOrNull" | "refundCapability" | "refundPayment"
  >,
  paymentReference: string,
  answer: {
    sent: () => TAnswer;
    failed: () => TAnswer;
    withhold: (admission: WithheldRefund) => TAnswer;
  },
  /**
   * Whether a charge the provider cannot state may still be sent back. Only
   * the rejected-charge recovery sets this, and only it can: that path exists
   * BECAUSE the charge's numbers came back unusable, so asking the guard to
   * read them asks the question that already failed.
   *
   * It still only sends where a repeat is harmless — a keyed provider rejects
   * a second full refund itself, a keyless one would pay twice.
   */
  sendWhenUnreadable = false,
): Promise<TAnswer> => {
  const admission = await admitProviderRefund(provider, paymentReference);
  if (admission.kind !== "send") {
    const repeatIsHarmless =
      sendWhenUnreadable &&
      admission.kind === "unreadable" &&
      provider.refundCapability === "keyed";
    if (!repeatIsHarmless) return answer.withhold(admission);
  }
  return (await provider.refundPayment(paymentReference))
    ? answer.sent()
    : answer.failed();
};
