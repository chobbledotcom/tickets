import { admitObservedRefund } from "#shared/payment/admit-refund.ts";
import type { RefundCandidate } from "./candidates.ts";
import type { AttendeeDoubt, HeldRefundWork } from "./claim.ts";
import { rememberFailedRefundLedger } from "./ledger-findings.ts";
import { recordProviderReviewFindings } from "./provider-reviews.ts";
import type {
  RefundReadinessRead,
  RefundReadinessResult,
} from "./readiness.ts";

type FailedReadiness = Extract<RefundReadinessResult, { kind: "not_ready" }>;

const referenceIndexesFor = (candidate: RefundCandidate): ReadonlySet<string> =>
  new Set(candidate.references.map(({ index }) => index));

const observationsFor = (
  candidate: RefundCandidate,
  readiness: FailedReadiness,
): FailedReadiness["observations"] => {
  const indexes = referenceIndexesFor(candidate);
  return readiness.observations.filter(({ reference }) =>
    indexes.has(reference.index),
  );
};

const rememberEvidenceForCandidate = (
  candidate: RefundCandidate,
  readiness: FailedReadiness,
  held: HeldRefundWork,
): void => {
  const attendeeId = candidate.attendee.id;
  if (readiness.reason === "historical_marker") {
    const indexes = new Set(readiness.indexes);
    const returned = candidate.references.filter(({ index }) =>
      indexes.has(index),
    );
    if (returned.length > 0) {
      rememberFailedRefundLedger(held.findings, attendeeId, returned);
    }
  }
  for (const { charge, reference } of observationsFor(candidate, readiness)) {
    const admission = admitObservedRefund(reference.reference, charge);
    if (admission.kind === "already_returned") {
      rememberFailedRefundLedger(held.findings, attendeeId, [reference]);
    } else if (admission.kind === "in_flight") {
      held.findings.doubts.set(attendeeId, "in_doubt");
    } else if (admission.kind === "refused") {
      recordProviderReviewFindings(held.findings, [
        { reason: admission.issue, reference },
      ]);
    }
  }
};

const ambiguousReadSawMoneyMove = (read: RefundReadinessRead): boolean =>
  read.evidence.status === "unresolved" &&
  read.evidence.attempts.some(
    ({ result }) =>
      result.status === "found" &&
      admitObservedRefund(read.evidence.reference, result.resource).kind !==
        "send",
  );

const ambiguousMoneyFor = (
  candidate: RefundCandidate,
  readiness: FailedReadiness,
): boolean => {
  if (readiness.reason !== "provider_evidence") return false;
  const indexes = referenceIndexesFor(candidate);
  return readiness.reads.some(
    (read) => indexes.has(read.index) && ambiguousReadSawMoneyMove(read),
  );
};

/** Record one safety doubt for each named refund attendee. */
export const rememberRefundDoubts = (
  candidates: readonly RefundCandidate[],
  held: HeldRefundWork,
  doubt: AttendeeDoubt,
): void => {
  for (const candidate of candidates) {
    held.findings.doubts.set(candidate.attendee.id, doubt);
  }
};

/** Preserve every money fact a failed complete-read attempt did establish. */
export const rememberReadinessFailureFindings = (
  candidates: readonly RefundCandidate[],
  readiness: FailedReadiness,
  held: HeldRefundWork,
): void => {
  rememberRefundDoubts(candidates, held, "unread");
  for (const candidate of candidates) {
    const attendeeId = candidate.attendee.id;
    rememberEvidenceForCandidate(candidate, readiness, held);
    if (ambiguousMoneyFor(candidate, readiness)) {
      // The money evidence is real, but its provider identity is not.
      held.findings.doubts.set(attendeeId, "in_doubt");
    }
  }
};
