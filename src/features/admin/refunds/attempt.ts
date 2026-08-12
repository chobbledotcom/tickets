import { markPaymentReferencesProviderRefunded } from "#shared/db/payment-references.ts";
import { ErrorCode, logError } from "#shared/logger.ts";
import type { ObservedRefundAdmission } from "#shared/payment/admit-refund.ts";
import type { RefundRequest } from "#shared/payment/refund-attempt.ts";
import { reportWithheldRefund } from "#shared/payment-review.ts";
import { mapProviderRequests } from "./provider-requests.ts";
import type {
  ReadyRefundCandidate,
  ReadyRefundProvider,
  ReadyRefundReference,
} from "./readiness.ts";
import { readyRefundAdmission } from "./ready-admission.ts";
import { reportRefundProblem } from "./report.ts";
import type { ProviderReviewFinding } from "./provider-reviews.ts";
import { combineRefundOutcomes, type RefundOutcome } from "./waves.ts";

type TaggedRefundReference = ReadyRefundReference["reference"];
type ObservedWithheldRefund = Exclude<
  ObservedRefundAdmission,
  { kind: "send" }
>;

export type MarkReturnedReferences = (
  references: readonly TaggedRefundReference[],
) => Promise<void>;

const refusedRefund = (detail: string, listingId: number): RefundOutcome => {
  reportRefundProblem(detail, listingId);
  return "failed";
};

/** One reference's result. A charge we never had to ask about carries none. */
export type ReferenceRefund = {
  doubt?: "in_doubt";
  outcome: RefundOutcome;
  review?: ProviderReviewFinding["reason"];
};

/** A readiness answer shared by every attendee carrying the same reference. */
export type PreparedReferenceRefund =
  | { kind: "answered"; result: ReferenceRefund }
  | { kind: "ready"; send: () => Promise<ReferenceRefund> };

/** Do the work at most once per stable provider-aware identity. */
const answeredOnce = <TAnswer>(
  asked: Map<string, Promise<TAnswer>>,
  index: string,
  ask: () => Promise<TAnswer>,
): Promise<TAnswer> => {
  const started = asked.get(index);
  if (started !== undefined) return started;
  const running = ask();
  asked.set(index, running);
  return running;
};

/** Start one provider request even when several attendees share its charge. */
const sendOnce = <TAnswer>(
  send: () => Promise<TAnswer>,
): () => Promise<TAnswer> => {
  let running: Promise<TAnswer> | undefined;
  return () => {
    running ??= send();
    return running;
  };
};

const refunded = (): ReferenceRefund => ({ outcome: "refunded" });

const withheldResult = (
  admission: ObservedWithheldRefund,
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
  if (admission.kind === "refused") {
    return { outcome: "withheld", review: admission.issue };
  }
  return admission.kind === "in_flight"
    ? { doubt: "in_doubt", outcome: "pending" }
    : { outcome: "withheld" };
};

const sendReferenceRefund = async (
  provider: ReadyRefundProvider,
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
  candidate: ReadyRefundCandidate,
  listingId: number,
  ready: ReadyRefundReference,
  observeOnly: boolean,
): Promise<PreparedReferenceRefund> => {
  const admission = readyRefundAdmission(ready);
  if (admission.kind !== "send") {
    return {
      kind: "answered",
      result: withheldResult(
        admission,
        candidate.attendee.id,
        listingId,
        ready.reference.reference,
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
        ready.provider,
        candidate.attendee.id,
        listingId,
        admission.request,
      )
    ),
  };
};

/** What one attendee's refund came to. */
export type CandidateRefund = {
  candidate: ReadyRefundCandidate;
  outcome: RefundOutcome;
  /** Provider conflicts that must remain visible after this request. */
  reviews: readonly ProviderReviewFinding[];
  /** The provider-tagged charges that actually went back. */
  returned: readonly TaggedRefundReference[];
  doubt?: "in_doubt";
};

/** Refund one readiness-qualified attendee without doing another provider read. */
export const refundReadyCandidate = async (
  candidate: ReadyRefundCandidate,
  listingId: number,
  markReturnedReferences: MarkReturnedReferences =
    markPaymentReferencesProviderRefunded,
  inFlight: Map<string, Promise<PreparedReferenceRefund>> = new Map(),
  observeOnly: ReadonlySet<string> = new Set(),
): Promise<CandidateRefund> => {
  const prepared = await mapProviderRequests(
    candidate.references,
    async (ready) => ({
      ...(await answeredOnce(
        inFlight,
        ready.reference.index,
        () =>
          prepareReferenceRefund(
            candidate,
            listingId,
            ready,
            observeOnly.has(ready.reference.index),
          ),
      )),
      reference: ready.reference,
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
    : undefined;
  const returnedReferences = results
    .filter((result) => result.outcome === "refunded")
    .map((result) => result.reference);
  const reviews = results.flatMap(({ reference, review }) =>
    review === undefined ? [] : [{ reason: review, reference }]
  );
  try {
    await markReturnedReferences(returnedReferences);
  } catch (error) {
    reportRefundProblem(
      `Admin refund could not record returned payments for attendee ${candidate.attendee.id}: ${
        String(
          error,
        )
      }`,
      listingId,
    );
    return {
      candidate,
      doubt: "in_doubt",
      outcome: outcome === "refunded" ? outcome : "errored",
      reviews,
      returned: returnedReferences,
    };
  }
  if (
    (outcome === "failed" || outcome === "errored") &&
    candidate.references.length > 1
  ) {
    logError({
      code: ErrorCode.PAYMENT_REFUND,
      detail:
        `Admin refund did not complete every payment for attendee ${candidate.attendee.id}`,
      listingId,
    });
  }
  return {
    candidate,
    ...(doubt !== undefined ? { doubt } : {}),
    outcome,
    reviews,
    returned: returnedReferences,
  };
};
