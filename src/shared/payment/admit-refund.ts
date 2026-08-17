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
import type { ProviderRead } from "#shared/payment/provider-read.ts";
import type { RefundRequest } from "#shared/payment/refund-attempt.ts";
import type { ChargeMoney } from "#shared/payment/resources.ts";

/** What to do about a refund somebody asked for. Only `send` reaches a
 *  provider; the rest are answers we already have. */
export type RefundAdmission =
  | { issue: PaymentConflict; kind: "refused" }
  | { kind: "already_returned" }
  | { kind: "in_flight" }
  | { kind: "send" };

/** Admission from charge facts that were already validated at the provider
 * boundary. It cannot carry a read failure because no read happens here. */
export type ObservedRefundAdmission =
  | Exclude<RefundAdmission, { kind: "send" }>
  | { kind: "send"; request: RefundRequest };

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

/** An answer that sends no money. A failed provider read keeps its exact
 * reason so each recovery path can make the right repair. */
export type WithheldRefund =
  | Exclude<ObservedRefundAdmission, { kind: "send" }>
  | {
      kind: "read_failed";
      read: Exclude<ProviderRead<ChargeMoney>, { status: "found" }>;
    };

/** Why no money was sent, in words for a log line. Only the refusal needs the
 *  problem's name, so the rest read the same wherever they are reported. */
export const admissionReason = (admission: WithheldRefund): string =>
  admission.kind === "read_failed"
    ? providerReadReason(admission.read)
    : admission.kind === "refused"
      ? `needs the owner to look at it (${admission.issue.kind})`
      : ADMISSION_REASONS[admission.kind];

const PROVIDER_READ_REASONS = {
  invalid: "the provider returned invalid data",
  missing: "the provider says the charge does not exist",
  unavailable: "the provider could not answer",
} as const satisfies Record<
  Exclude<ProviderRead<never>, { status: "found" }>["status"],
  string
>;

const providerReadReason = (
  read: Exclude<ProviderRead<never>, { status: "found" }>,
): string =>
  `${PROVIDER_READ_REASONS[read.status]}${
    "reason" in read ? ` (${read.reason})` : ""
  }`;

const ADMISSION_REASONS = {
  already_returned: "the money is already back",
  in_flight: "a refund is already on its way",
} as const satisfies Record<
  Exclude<RefundAdmission, { kind: "refused" } | { kind: "send" }>["kind"],
  string
>;

/** Decide from one already-validated provider reading without reading again. */
export const admitObservedRefund = (
  paymentReference: string,
  charge: ChargeMoney,
): ObservedRefundAdmission => {
  const admission = admitRefund(refundOutcomeOf([charge]));
  return admission.kind === "send"
    ? { kind: "send", request: { charge, paymentReference } }
    : admission;
};
