import { resolveQueuedBulkRefundPayments } from "#shared/db/payments/bulk-refunds.ts";
import { ErrorCode, logError } from "#shared/logger.ts";
import { refundPaymentTargets } from "#shared/payment-runtime/refund.ts";
import { recordAttendeeRefundsBatch } from "#shared/refund-ledger.ts";
import { type RefundCandidate, refundCandidatePayments } from "./candidates.ts";
import type { RefundOutcome } from "./waves.ts";

export type RefundCounts = {
  errorCount: number;
  failedCount: number;
  refundedCount: number;
};

export const refundCandidateAtProvider = async (
  candidate: RefundCandidate,
  listingId: number,
): Promise<{ candidate: RefundCandidate; outcome: RefundOutcome }> => {
  try {
    const outcomes = await refundPaymentTargets(candidate.targets);
    const outcome: RefundOutcome = outcomes.every(
      (result) => result.status === "completed",
    )
      ? "refunded"
      : "failed";
    if (outcome === "failed") {
      logError({
        code: ErrorCode.PAYMENT_REFUND,
        detail: `Admin refund did not complete every payment for attendee ${candidate.attendee.id}`,
        listingId,
      });
    }
    return { candidate, outcome };
  } catch (error) {
    logError({
      code: ErrorCode.PAYMENT_REFUND,
      detail: `Admin refund errored for attendee ${candidate.attendee.id}: ${String(error)}`,
      listingId,
    });
    return { candidate, outcome: "errored" };
  }
};

const tallyProviderRefund = (
  counts: RefundCounts,
  candidate: RefundCandidate,
  outcome: RefundOutcome,
  refundedAttendees: RefundCandidate[],
): void => {
  if (outcome === "errored") counts.errorCount++;
  else if (outcome === "failed") counts.failedCount++;
  else {
    refundedAttendees.push(candidate);
  }
};

export const processRefundBatch = async (
  batch: RefundCandidate[],
  listingId: number,
): Promise<RefundCounts> => {
  const counts: RefundCounts = {
    errorCount: 0,
    failedCount: 0,
    refundedCount: 0,
  };
  const results = await Promise.all(
    batch.map((candidate) => refundCandidateAtProvider(candidate, listingId)),
  );
  const refunded: RefundCandidate[] = [];
  for (const result of results) {
    tallyProviderRefund(counts, result.candidate, result.outcome, refunded);
  }
  const posted = await recordAttendeeRefundsBatch(
    refunded.map((candidate) => ({
      attendeeId: candidate.attendee.id,
      references: candidate.references,
    })),
  );
  const completed = refunded.filter((candidate) => {
    const ok = posted.get(candidate.attendee.id) === true;
    if (ok) counts.refundedCount++;
    else counts.errorCount++;
    return ok;
  });
  await resolveQueuedBulkRefundPayments(refundCandidatePayments(completed));
  return counts;
};
