import { requiredMapValue } from "#fp";
import type {
  ArmRefundDispatchResult,
  RefundDispatchPermit,
} from "#shared/db/payment-refund-dispatch.ts";
import type { ObservedRefundAdmission } from "#shared/payment/admit-refund.ts";
import type { RefundRequest } from "#shared/payment/refund-attempt.ts";
import {
  reportFailedRefundAttempt,
  reportWithheldRefund,
} from "#shared/payment-review.ts";
import { mapProviderRequests } from "./provider-requests.ts";
import type { ProviderReviewFinding } from "./provider-reviews.ts";
import type {
  ReadyRefundCandidate,
  ReadyRefundProvider,
  ReadyRefundReference,
} from "./readiness.ts";
import { readyRefundAdmission } from "./ready-admission.ts";
import { reportRefundProblem } from "./report.ts";
import { combineRefundOutcomes, type RefundOutcome } from "./waves.ts";

type TaggedRefundReference = ReadyRefundReference["reference"];
type ObservedWithheldRefund = Exclude<
  ObservedRefundAdmission,
  { kind: "send" }
>;

/** One reference's result. A charge we never had to ask about carries none. */
export type ReferenceRefund = {
  doubt?: "in_doubt";
  outcome: RefundOutcome;
  review?: ProviderReviewFinding["reason"];
};

/** A readiness answer shared by every attendee carrying the same reference. */
export type PreparedReferenceRefund =
  | { kind: "answered"; result: ReferenceRefund }
  | {
      kind: "ready";
      send: (permit: RefundDispatchPermit) => Promise<ReferenceRefund>;
    };

export type PreparedRefundAttempt = PreparedReferenceRefund & {
  readonly reference: TaggedRefundReference;
};

/** One attendee after every send/no-send decision is known but none has run. */
export type PreparedCandidateRefund = {
  readonly attempts: readonly PreparedRefundAttempt[];
  readonly candidate: ReadyRefundCandidate;
};

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
  send: (permit: RefundDispatchPermit) => Promise<TAnswer>,
): ((permit: RefundDispatchPermit) => Promise<TAnswer>) => {
  let running: Promise<TAnswer> | undefined;
  return (permit) => {
    running ??= send(permit);
    return running;
  };
};

const refunded = (): ReferenceRefund => ({ outcome: "refunded" });

const withheldResult = (
  admission: ObservedWithheldRefund,
  attendeeId: number,
  listingId: number,
  provider: ReadyRefundProvider["type"],
): ReferenceRefund => {
  if (admission.kind === "already_returned") return refunded();
  reportWithheldRefund(admission, {
    attendeeId,
    listingId,
    provider,
  });
  if (admission.kind === "refused") {
    return { outcome: "withheld", review: admission.issue };
  }
  return { doubt: "in_doubt", outcome: "pending" };
};

const sendReferenceRefund = async (
  provider: ReadyRefundProvider,
  attendeeId: number,
  listingId: number,
  request: RefundRequest,
  index: string,
  permit: RefundDispatchPermit,
): Promise<ReferenceRefund> => {
  if (
    permit.index !== index ||
    permit.capability !== provider.refundCapability
  ) {
    throw new Error(`Refund dispatch permit does not match payment ${index}`);
  }
  const settled = (outcome: RefundOutcome): ReferenceRefund => ({ outcome });
  const result = await provider.refundCharge(request);
  if (result.kind === "completed") return settled("refunded");
  if (result.kind === "accepted") {
    return { doubt: "in_doubt", outcome: "pending" };
  }
  if (result.kind === "not_sent") return settled("withheld");
  if (result.kind === "rejected") {
    reportFailedRefundAttempt(result, {
      attendeeId,
      listingId,
      provider: provider.type,
    });
    return settled("failed");
  }
  reportFailedRefundAttempt(result, {
    attendeeId,
    listingId,
    provider: provider.type,
  });
  return { doubt: "in_doubt", outcome: "errored" };
};

const prepareReferenceRefund = (
  candidate: ReadyRefundCandidate,
  listingId: number,
  ready: ReadyRefundReference,
): Promise<PreparedReferenceRefund> => {
  const admission = readyRefundAdmission(ready);
  if (admission.kind !== "send") {
    return Promise.resolve({
      kind: "answered",
      result: withheldResult(
        admission,
        candidate.attendee.id,
        listingId,
        ready.provider.type,
      ),
    });
  }
  return Promise.resolve({
    kind: "ready",
    send: sendOnce((permit) =>
      sendReferenceRefund(
        ready.provider,
        candidate.attendee.id,
        listingId,
        admission.request,
        ready.reference.index,
        permit,
      ),
    ),
  });
};

const authorizedResult = (
  authorization: ArmRefundDispatchResult | undefined,
  attempt: Extract<PreparedReferenceRefund, { kind: "ready" }>,
  reference: TaggedRefundReference,
): Promise<ReferenceRefund> => {
  if (authorization === undefined) {
    throw new Error(`Refund ${reference.index} had no dispatch decision`);
  }
  if (authorization.kind === "claim_changed") {
    return Promise.resolve({ outcome: "failed" });
  }
  if (authorization.kind === "owner_review") {
    return Promise.resolve(
      authorization.indexes.includes(reference.index)
        ? {
            outcome: "withheld",
            review: { kind: authorization.reason },
          }
        : { outcome: "withheld" },
    );
  }
  return attempt.send(
    requiredMapValue(
      authorization.permits,
      reference.index,
      `Refund dispatch omitted payment ${reference.index}`,
    ),
  );
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

/** Decide every reference without authorizing or starting a provider send. */
export const prepareReadyCandidate = async (
  candidate: ReadyRefundCandidate,
  listingId: number,
  inFlight: Map<string, Promise<PreparedReferenceRefund>> = new Map(),
): Promise<PreparedCandidateRefund> => {
  const prepared = await mapProviderRequests(
    candidate.references,
    async (ready): Promise<PreparedRefundAttempt> => ({
      ...(await answeredOnce(inFlight, ready.reference.index, () =>
        prepareReferenceRefund(candidate, listingId, ready),
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
  return { attempts, candidate };
};

type ReferenceRefundResult = ReferenceRefund & {
  readonly reference: TaggedRefundReference;
};

const candidateResult = (
  prepared: PreparedCandidateRefund,
  results: readonly ReferenceRefundResult[],
  incompleteListingId?: number,
): CandidateRefund => {
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
    review === undefined ? [] : [{ reason: review, reference }],
  );
  if (
    incompleteListingId !== undefined &&
    (outcome === "failed" || outcome === "errored") &&
    prepared.candidate.references.length > 1
  ) {
    reportRefundProblem(
      {
        attendeeId: prepared.candidate.attendee.id,
        kind: "incomplete_batch",
        paymentCount: prepared.candidate.references.length,
      },
      incompleteListingId,
    );
  }
  return {
    candidate: prepared.candidate,
    ...(doubt !== undefined ? { doubt } : {}),
    outcome,
    returned: returnedReferences,
    reviews,
  };
};

/** Finish one prepared attendee under the batch-wide dispatch decision. */
export const finishPreparedCandidate = async (
  prepared: PreparedCandidateRefund,
  listingId: number,
  authorization: ArmRefundDispatchResult | undefined,
): Promise<CandidateRefund> => {
  const results = await mapProviderRequests(
    prepared.attempts,
    async (attempt): Promise<ReferenceRefundResult> => ({
      ...(attempt.kind === "ready"
        ? await authorizedResult(authorization, attempt, attempt.reference)
        : attempt.result),
      reference: attempt.reference,
    }),
  );
  return candidateResult(prepared, results, listingId);
};

/** Preserve non-send safety findings when a prepared batch stands down. */
export const standDownPreparedCandidate = (
  prepared: PreparedCandidateRefund,
): CandidateRefund =>
  candidateResult(
    prepared,
    prepared.attempts.map((attempt) => ({
      ...(attempt.kind === "ready"
        ? { outcome: "failed" as const }
        : attempt.result),
      reference: attempt.reference,
    })),
  );
