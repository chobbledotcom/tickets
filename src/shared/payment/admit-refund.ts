/**
 * Whether a refund may be sent, given what the provider says has already
 * happened to the money.
 *
 * Every refund route asks this before it calls a provider, so "the money is
 * already back" and "a refund is already on its way" stop the call rather than
 * being discovered by making it. Stripe and Square would reject a second full
 * refund on their own, but SumUp carries no idempotency key, so a second call
 * there sends the money twice.
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

/** The answer for each way a reading can come out settled. Listing them
 *  exhaustively means a new outcome must say what it does about refunds here,
 *  rather than falling into whichever arm happens to be last. */
const ADMISSION_BY_OUTCOME = {
  fully_refunded: { kind: "already_returned" },
  ready: { kind: "send" },
  refund_pending: { kind: "in_flight" },
} as const satisfies Record<
  Exclude<ObservationOutcome, { kind: "conflict" }>["kind"],
  RefundAdmission
>;

/**
 * Turn what a reading came to into what to do about a refund. A problem the
 * owner has to look at never sends money: the reading and the booking disagree,
 * and sending more money into that disagreement is how one buyer is paid twice.
 */
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
 * Ask the provider what has become of this charge's money, and answer whether a
 * refund may be sent. A charge the provider cannot state is never refunded on
 * the hope that it was fine: unreadable evidence and "already back" look
 * identical from here, and only one of them is safe to send money against.
 *
 * A read that fails outright is the same answer as one that comes back empty —
 * the provider did not say. Catching it here is what keeps it distinct from a
 * refund CALL that failed: no money was asked for, so the caller is free to
 * try again in a moment rather than treating this as money possibly in flight.
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

/**
 * The whole refund mechanism: ask what the money has already done, send more
 * only if it may be sent, and hand back whichever answer fits.
 *
 * The refund routes report their results differently — one a plain yes or no,
 * one a word for a bulk tally — but they must never differ on WHEN money
 * leaves, so every step up to the provider call lives here once and each route
 * only says how to phrase the three endings.
 */
export const sendRefundIfAdmitted = async <TAnswer>(
  provider: Pick<PaymentProvider, "readChargeMoneyOrNull" | "refundPayment">,
  paymentReference: string,
  answer: {
    sent: () => TAnswer;
    failed: () => TAnswer;
    withhold: (admission: WithheldRefund) => TAnswer;
  },
): Promise<TAnswer> => {
  const admission = await admitProviderRefund(provider, paymentReference);
  if (admission.kind !== "send") return answer.withhold(admission);
  return (await provider.refundPayment(paymentReference))
    ? answer.sent()
    : answer.failed();
};
