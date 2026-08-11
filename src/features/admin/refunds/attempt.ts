import {
  markPaymentReferencesProviderRefunded,
  type RefundPaymentReference,
} from "#shared/db/payment-references.ts";
import { ErrorCode, logError } from "#shared/logger.ts";
import {
  admitProviderRefund,
  type WithheldRefund,
} from "#shared/payment/admit-refund.ts";
import type { RefundRequest } from "#shared/payment/refund-attempt.ts";
import { reportWithheldRefund } from "#shared/payment-review.ts";
import type { getActivePaymentProvider } from "#shared/payments.ts";
import type { RefundCandidate } from "./candidates.ts";
import { mapProviderRequests } from "./provider-requests.ts";
import { reportRefundProblem } from "./report.ts";
import { combineRefundOutcomes, type RefundOutcome } from "./waves.ts";

export type RefundProvider = Pick<
  NonNullable<Awaited<ReturnType<typeof getActivePaymentProvider>>>,
  "readCharge" | "refundCapability" | "refundCharge"
>;

export type MarkReturnedReferences = (
  references: readonly RefundPaymentReference[],
) => Promise<void>;

const refusedRefund = (detail: string, listingId: number): RefundOutcome => {
  reportRefundProblem(detail, listingId);
  return "failed";
};

/** What a run could not prove about one charge. */
export type RefundDoubt = "in_doubt" | "unread";

/** One reference's result. A charge we never had to ask about carries none. */
export type ReferenceRefund = {
  doubt?: RefundDoubt;
  outcome: RefundOutcome;
};

/** A read answer shared by every attendee carrying the same reference. */
export type PreparedReferenceRefund =
  | { kind: "answered"; result: ReferenceRefund }
  | { kind: "ready"; send: () => Promise<ReferenceRefund> };

/** Do the work at most once per key. */
const answeredOnce = <TAnswer>(
  asked: Map<string, Promise<TAnswer>>,
  key: string,
  ask: () => Promise<TAnswer>,
): Promise<TAnswer> => {
  const started = asked.get(key);
  if (started !== undefined) return started;
  const running = ask();
  asked.set(key, running);
  return running;
};

/** Start one provider request even when several attendees share its charge. */
const sendOnce = <TAnswer>(
  send: () => Promise<TAnswer>,
): (() => Promise<TAnswer>) => {
  let running: Promise<TAnswer> | undefined;
  return () => {
    running ??= send();
    return running;
  };
};

const refunded = (): ReferenceRefund => ({ outcome: "refunded" });

const withheldResult = (
  admission: WithheldRefund,
  attendeeId: number,
  listingId: number,
  paymentReference: string,
): ReferenceRefund => {
  if (admission.kind === "already_returned") return refunded();
  reportWithheldRefund(admission, {
    attendeeId,
    listingId,
    paymentReference,
  });
  if (admission.kind === "read_failed") {
    return { doubt: "unread", outcome: "withheld" };
  }
  return admission.kind === "in_flight"
    ? { doubt: "in_doubt", outcome: "pending" }
    : { outcome: "withheld" };
};

const sendReferenceRefund = async (
  provider: RefundProvider,
  attendeeId: number,
  listingId: number,
  request: RefundRequest,
): Promise<ReferenceRefund> => {
  const paymentReference = request.paymentReference;
  const settled = (outcome: RefundOutcome): ReferenceRefund => ({ outcome });
  const result = await provider.refundCharge(request);
  if (result.kind === "completed") return settled("refunded");
  if (result.kind === "accepted") {
    return { doubt: "in_doubt", outcome: "pending" };
  }
  if (result.kind === "not_sent") return settled("withheld");
  if (result.kind === "rejected") {
    return settled(
      refusedRefund(
        `Admin refund rejected for attendee ${attendeeId}, payment ${paymentReference} (${result.reason})`,
        listingId,
      ),
    );
  }
  reportRefundProblem(
    `Admin refund errored for attendee ${attendeeId}, payment ${paymentReference} (${result.reason})`,
    listingId,
  );
  return { doubt: "in_doubt", outcome: "errored" };
};

const prepareReferenceRefund = async (
  provider: RefundProvider,
  candidate: RefundCandidate,
  listingId: number,
  reference: RefundPaymentReference,
  alreadyReturned: ReadonlySet<string>,
  observeOnly: boolean,
): Promise<PreparedReferenceRefund> => {
  // What the claimed row says now beats the list loaded before the hold.
  if (
    reference.refundState === "completed" ||
    alreadyReturned.has(reference.index)
  ) {
    return { kind: "answered", result: refunded() };
  }
  const admission = await admitProviderRefund(provider, reference.reference);
  if (admission.kind !== "send") {
    return {
      kind: "answered",
      result: withheldResult(
        admission,
        candidate.attendee.id,
        listingId,
        reference.reference,
      ),
    };
  }
  if (observeOnly) {
    return {
      kind: "answered",
      result: { doubt: "in_doubt", outcome: "pending" },
    };
  }
  return {
    kind: "ready",
    send: sendOnce(() =>
      sendReferenceRefund(
        provider,
        candidate.attendee.id,
        listingId,
        admission.request,
      ),
    ),
  };
};

/** What one attendee's refund came to. */
export type CandidateRefund = {
  candidate: RefundCandidate;
  outcome: RefundOutcome;
  /** The charges that actually went back. */
  returned: readonly RefundPaymentReference[];
  doubt?: RefundDoubt;
};

export const refundCandidateAtProvider = async (
  provider: RefundProvider,
  candidate: RefundCandidate,
  listingId: number,
  markReturnedReferences: MarkReturnedReferences = markPaymentReferencesProviderRefunded,
  alreadyReturned: ReadonlySet<string> = new Set(),
  inFlight: Map<string, Promise<PreparedReferenceRefund>> = new Map(),
  observeOnly: ReadonlySet<string> = new Set(),
): Promise<CandidateRefund> => {
  const prepared = await mapProviderRequests(
    candidate.references,
    async (reference) => ({
      ...(await answeredOnce(inFlight, reference.reference, () =>
        prepareReferenceRefund(
          provider,
          candidate,
          listingId,
          reference,
          alreadyReturned,
          observeOnly.has(reference.reference),
        ),
      )),
      reference,
    }),
  );
  const blocked = prepared.some(
    (attempt) =>
      attempt.kind === "answered" && attempt.result.outcome !== "refunded",
  );
  const attempts = blocked
    ? prepared.filter((attempt) => attempt.kind === "answered")
    : prepared;
  const results = await mapProviderRequests(attempts, async (attempt) => ({
    ...(attempt.kind === "ready" ? await attempt.send() : attempt.result),
    reference: attempt.reference,
  }));
  const outcome = combineRefundOutcomes(
    results.map((result) => result.outcome),
  );
  const doubt = results.some((result) => result.doubt === "in_doubt")
    ? "in_doubt"
    : results.find((result) => result.doubt === "unread")?.doubt;
  const returnedReferences = results
    .filter((result) => result.outcome === "refunded")
    .map((result) => result.reference);
  try {
    await markReturnedReferences(returnedReferences);
  } catch (error) {
    reportRefundProblem(
      `Admin refund could not record returned payments for attendee ${candidate.attendee.id}: ${String(
        error,
      )}`,
      listingId,
    );
    if (outcome !== "refunded") {
      return {
        candidate,
        doubt: "in_doubt",
        outcome: "errored",
        returned: returnedReferences,
      };
    }
    return {
      candidate,
      doubt: "in_doubt",
      outcome,
      returned: returnedReferences,
    };
  }
  if (
    (outcome === "failed" || outcome === "errored") &&
    candidate.references.length > 1
  ) {
    logError({
      code: ErrorCode.PAYMENT_REFUND,
      detail: `Admin refund did not complete every payment for attendee ${candidate.attendee.id}`,
      listingId,
    });
  }
  return {
    candidate,
    ...(doubt !== undefined ? { doubt } : {}),
    outcome,
    returned: returnedReferences,
  };
};
