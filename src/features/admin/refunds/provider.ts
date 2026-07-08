import { chunk } from "#fp";
import {
  markPaymentReferencesProviderRefunded,
  type RefundPaymentReference,
} from "#shared/db/payment-references.ts";
import { ErrorCode, logError } from "#shared/logger.ts";
import type { getActivePaymentProvider } from "#shared/payments.ts";
import { recordAttendeeRefundsBatch } from "#shared/refund-ledger.ts";
import type { RefundCandidate } from "./candidates.ts";

type RefundProvider = Pick<
  NonNullable<Awaited<ReturnType<typeof getActivePaymentProvider>>>,
  "isPaymentRefunded" | "refundPayment"
>;
type MarkReturnedReferences = (
  references: readonly RefundPaymentReference[],
) => Promise<void>;

type RefundOutcome = "refunded" | "failed" | "errored";

export type RefundCounts = {
  refundedCount: number;
  failedCount: number;
  errorCount: number;
};

const refundReferenceAtProvider = async (
  provider: RefundProvider,
  candidate: RefundCandidate,
  listingId: number,
  reference: RefundPaymentReference,
): Promise<RefundOutcome> => {
  const attendeeId = candidate.attendee.id;
  const paymentReference = reference.reference;
  try {
    if (reference.providerRefunded) return "refunded";
    if (await provider.refundPayment(paymentReference)) return "refunded";
    if (await provider.isPaymentRefunded(paymentReference)) return "refunded";
    logError({
      code: ErrorCode.PAYMENT_REFUND,
      detail: `Admin refund failed for attendee ${attendeeId}, payment ${paymentReference}`,
      listingId,
    });
    return "failed";
  } catch (err) {
    logError({
      code: ErrorCode.PAYMENT_REFUND,
      detail: `Admin refund errored for attendee ${attendeeId}, payment ${paymentReference}: ${String(
        err,
      )}`,
      listingId,
    });
    return "errored";
  }
};

const combineRefundOutcomes = (outcomes: RefundOutcome[]): RefundOutcome => {
  if (outcomes.includes("errored")) return "errored";
  if (outcomes.includes("failed")) return "failed";
  return "refunded";
};

export const refundCandidateAtProvider = async (
  provider: RefundProvider,
  candidate: RefundCandidate,
  listingId: number,
  markReturnedReferences: MarkReturnedReferences = markPaymentReferencesProviderRefunded,
): Promise<{ candidate: RefundCandidate; outcome: RefundOutcome }> => {
  const results = await Promise.all(
    candidate.references.map(async (reference) => ({
      outcome: await refundReferenceAtProvider(
        provider,
        candidate,
        listingId,
        reference,
      ),
      reference,
    })),
  );
  const outcome = combineRefundOutcomes(
    results.map((result) => result.outcome),
  );
  const returnedReferences = results
    .filter((result) => result.outcome === "refunded")
    .map((result) => result.reference);
  try {
    await markReturnedReferences(returnedReferences);
  } catch (error) {
    logError({
      code: ErrorCode.PAYMENT_REFUND,
      detail: `Admin refund could not record returned payments for attendee ${candidate.attendee.id}: ${String(
        error,
      )}`,
      listingId,
    });
    if (outcome !== "refunded") return { candidate, outcome: "errored" };
  }
  if (outcome !== "refunded" && candidate.references.length > 1) {
    logError({
      code: ErrorCode.PAYMENT_REFUND,
      detail: `Admin refund did not complete every payment for attendee ${candidate.attendee.id}`,
      listingId,
    });
  }
  return { candidate, outcome };
};

const logBulkRefundProblem = (
  outcome: Exclude<RefundOutcome, "refunded">,
  candidate: RefundCandidate,
  listingId: number,
): void => {
  const refs = candidate.references
    .map((reference) => reference.reference)
    .join(", ");
  logError({
    code: ErrorCode.PAYMENT_REFUND,
    detail: `Admin bulk refund ${outcome} for attendee ${candidate.attendee.id}, payments ${refs}`,
    listingId,
  });
};

const tallyProviderRefund = (
  counts: RefundCounts,
  candidate: RefundCandidate,
  outcome: RefundOutcome,
  listingId: number,
  refundedAttendees: {
    attendeeId: number;
    references: readonly RefundPaymentReference[];
  }[],
): void => {
  if (outcome === "errored") {
    counts.errorCount++;
    logBulkRefundProblem(outcome, candidate, listingId);
  } else if (outcome === "failed") {
    counts.failedCount++;
    logBulkRefundProblem(outcome, candidate, listingId);
  } else {
    refundedAttendees.push({
      attendeeId: candidate.attendee.id,
      references: candidate.references,
    });
  }
};

/** Refund one chunk of attendees at the provider, then record full successes in
 * the ledger before starting the next chunk. */
export const processRefundBatch = async (
  provider: RefundProvider,
  batch: RefundCandidate[],
  listingId: number,
): Promise<RefundCounts> => {
  const REFUND_CHUNK_SIZE = 5;
  const counts: RefundCounts = {
    errorCount: 0,
    failedCount: 0,
    refundedCount: 0,
  };
  for (const group of chunk(REFUND_CHUNK_SIZE)(batch)) {
    const results = await Promise.all(
      group.map((candidate) =>
        refundCandidateAtProvider(provider, candidate, listingId),
      ),
    );
    const chunkRefundedAttendees: {
      attendeeId: number;
      references: readonly RefundPaymentReference[];
    }[] = [];
    for (const { candidate, outcome } of results) {
      tallyProviderRefund(
        counts,
        candidate,
        outcome,
        listingId,
        chunkRefundedAttendees,
      );
    }
    const posted = await recordAttendeeRefundsBatch(chunkRefundedAttendees);
    for (const ok of posted.values()) {
      if (ok) counts.refundedCount++;
      else counts.errorCount++;
    }
  }
  return counts;
};
