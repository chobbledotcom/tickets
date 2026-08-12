import { refundOutcomeOf } from "#shared/payment/diagnose.ts";
import { type Money, sameMoney } from "#shared/payment/money.ts";
import type {
  ProviderInvalidReason,
  ProviderRead,
  ProviderReader,
  ProviderUnavailableReason,
} from "#shared/payment/provider-read.ts";
import type {
  ChargeMoney,
  ProviderRefundResource,
} from "#shared/payment/resources.ts";

/** Evidence that identifies the refund or the provider reading that confirms
 * it. SumUp names no refund resource in its answer, so only its fresh charge
 * reading can prove what happened. */
export type RefundProof =
  | { kind: "named_refund"; refund: ProviderRefundResource }
  | { charge: ChargeMoney; kind: "charge_observation" };

/** Why a provider definitely refused a refund without moving money. */
export type RefundRejectionReason = "canceled" | "failed" | "rejected";

/** One refund call's complete answer. `uncertain` means the call may have
 * landed; `not_sent` means it definitely did not leave this process. */
export type RefundAttemptResult =
  | { amount: Money; kind: "completed"; proof: RefundProof }
  | { amount: Money; kind: "accepted"; proof: RefundProof }
  | { kind: "rejected"; reason: RefundRejectionReason }
  | { kind: "not_sent"; reason: "not_configured" }
  | {
      kind: "uncertain";
      reason: ProviderUnavailableReason | ProviderInvalidReason;
    };

/** The facts every adapter receives before it may ask for money to move. */
export type RefundRequest = {
  charge: ChargeMoney;
  paymentReference: string;
};

type UncertainRefundAttempt = Extract<
  RefundAttemptResult,
  { kind: "uncertain" }
>;

/** Name an uncertain send without repeating its tagged-result shape. */
export const uncertainRefund = (
  reason: UncertainRefundAttempt["reason"],
): UncertainRefundAttempt => ({ kind: "uncertain", reason });

/** Everything the pure post-call judgment receives. A single read value makes
 * the bounded reread explicit: neither an adapter nor this judgment can loop. */
export interface RefundReread {
  readonly attempt: UncertainRefundAttempt;
  readonly freshCharge: ProviderRead<ChargeMoney>;
  readonly request: RefundRequest;
}

/** Reconcile an uncertain send from exactly one fresh charge observation. */
export const refundOutcomeAfterReread = ({
  attempt,
  freshCharge,
  request,
}: RefundReread): RefundAttemptResult => {
  if (freshCharge.status !== "found") return attempt;
  const charge = freshCharge.resource;
  if (!sameMoney(charge.captured, request.charge.captured)) {
    return uncertainRefund("mismatched_money");
  }
  if (refundOutcomeOf([charge]).kind !== "fully_refunded") return attempt;
  return {
    amount: request.charge.captured,
    kind: "completed",
    proof: { charge, kind: "charge_observation" },
  };
};

type RefundCharge = (request: RefundRequest) => Promise<RefundAttemptResult>;

/** Add the single post-call evidence read required after an uncertain send. */
export const refundWithOneReread =
  (send: RefundCharge, readCharge: ProviderReader<ChargeMoney>): RefundCharge =>
  async (request) => {
    const attempt = await send(request);
    if (attempt.kind !== "uncertain") return attempt;
    return refundOutcomeAfterReread({
      attempt,
      freshCharge: await readCharge(request.paymentReference),
      request,
    });
  };

/** A refund request after either the evidence gate or the provider call. */
export type RefundActionResult<Withheld> =
  | RefundAttemptResult
  | { admission: Withheld; kind: "withheld" };
