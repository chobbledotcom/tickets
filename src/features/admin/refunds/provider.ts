import { chunk } from "#fp";
import {
  type ClaimResult,
  claimAttendeeRows,
  releaseAttendeeRows,
} from "#shared/db/payment-claim.ts";
import {
  markPaymentReferencesProviderRefunded,
  type RefundPaymentReference,
} from "#shared/db/payment-references.ts";
import { reportRefundNotRecorded } from "#shared/invariant-errors.ts";
import { ErrorCode, logError } from "#shared/logger.ts";
import {
  admissionReason,
  sendRefundIfAdmitted,
} from "#shared/payment/admit-refund.ts";
import { claimRefusal, mayReleaseClaim } from "#shared/payment/claim.ts";
import type { RefundCapability } from "#shared/payment/row-state.ts";
import type { getActivePaymentProvider } from "#shared/payments.ts";
import { recordAttendeeRefundsBatch } from "#shared/refund-ledger.ts";
import type { RefundCandidate } from "./candidates.ts";
import {
  combineRefundOutcomes,
  packByReferenceCount,
  type RefundOutcome,
} from "./waves.ts";

type RefundProvider = Pick<
  NonNullable<Awaited<ReturnType<typeof getActivePaymentProvider>>>,
  "readChargeMoneyOrNull" | "refundCapability" | "refundPayment"
>;
type MarkReturnedReferences = (
  references: readonly RefundPaymentReference[],
) => Promise<void>;

/** Taking and letting go of the hold on an attendee's payment rows. Injected
 *  like the marker above so the tally and ordering rules can be tested without
 *  a database, while the real run always takes the durable claim. */
export type RowClaim = {
  claim: (
    attendeeIds: readonly number[],
    capability: RefundCapability,
  ) => Promise<ClaimResult>;
  release: (sessionIds: readonly string[], heldSince: string) => Promise<void>;
};

export const durableRowClaim: RowClaim = {
  claim: claimAttendeeRows,
  release: releaseAttendeeRows,
};

export type RefundCounts = {
  refundedCount: number;
  failedCount: number;
  errorCount: number;
};

/** Max provider refund subrequests in flight at once. Bounds concurrency by
 * charge reference, not attendee: an attendee can carry several references (a
 * deposit plus a balance charge, or a merged attendee's combined charges), so
 * capping attendees alone could still fan a bulk refund out to far more
 * subrequests than an edge worker can safely hold open. Waves are packed by
 * reference count and each candidate's own references are chunked to this too.
 * The refresh-payment status check reuses it to bound its own fan-out. */
export const PROVIDER_REFUND_CONCURRENCY = 5;

/** Log why one reference's money did not move, and report it as failed. */
const refusedRefund = (detail: string, listingId: number): RefundOutcome => {
  logError({ code: ErrorCode.PAYMENT_REFUND, detail, listingId });
  return "failed";
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
    if (reference.refundState === "completed") return "refunded";
    // What the money has already done decides whether more is sent — see
    // `sendRefundIfAdmitted`. SumUp has no idempotency key to fall back on.
    return await sendRefundIfAdmitted(provider, paymentReference, {
      failed: () =>
        refusedRefund(
          `Admin refund failed for attendee ${attendeeId}, payment ${paymentReference}`,
          listingId,
        ),
      sent: () => "refunded",
      withhold: (admission) =>
        admission.kind === "already_returned"
          ? "refunded"
          : refusedRefund(
              `Admin refund not sent for attendee ${attendeeId}, payment ${paymentReference}: ${admissionReason(admission)}`,
              listingId,
            ),
    });
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

/**
 * Hold every attendee this run will touch, do the work, then let go.
 *
 * One claim for the run rather than one per attendee: a bulk wave costs the
 * same two round trips as a single refund, which matters against the
 * subrequest allowance, and the run can never end up holding some of its
 * attendees but not others.
 *
 * A run that ended without a clear answer may have sent money it never heard
 * back about. With an idempotency key a repeat lands on the same refund, so
 * the hold can go; without one it stands until fresh evidence settles it.
 */
export const underAttendeeClaim = async <TResult>(
  rowClaim: RowClaim,
  attendeeIds: readonly number[],
  capability: RefundCapability,
  run: {
    blocked: (reason: string) => TResult;
    lost: (result: TResult) => boolean;
    work: () => Promise<TResult>;
  },
): Promise<TResult> => {
  const claim = await rowClaim.claim(attendeeIds, capability);
  if (claim.kind === "blocked") {
    return run.blocked(claimRefusal(claim.blockedBy));
  }
  const release = async (lost: boolean): Promise<void> => {
    if (mayReleaseClaim(capability, lost ? "lost" : "validated")) {
      await rowClaim.release(claim.sessionIds, claim.heldSince);
    }
  };
  try {
    const result = await run.work();
    await release(run.lost(result));
    return result;
  } catch (error) {
    await release(true);
    throw error;
  }
};

export const refundCandidateAtProvider = async (
  provider: RefundProvider,
  candidate: RefundCandidate,
  listingId: number,
  markReturnedReferences: MarkReturnedReferences = markPaymentReferencesProviderRefunded,
): Promise<{ candidate: RefundCandidate; outcome: RefundOutcome }> => {
  const results: {
    outcome: RefundOutcome;
    reference: RefundPaymentReference;
  }[] = [];
  // Chunk this attendee's own references so a merged attendee carrying many
  // charges never fans out past the concurrency budget on its own.
  for (const group of chunk(PROVIDER_REFUND_CONCURRENCY)(
    candidate.references,
  )) {
    const groupResults = await Promise.all(
      group.map(async (reference) => ({
        outcome: await refundReferenceAtProvider(
          provider,
          candidate,
          listingId,
          reference,
        ),
        reference,
      })),
    );
    results.push(...groupResults);
  }
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
  rowClaim: RowClaim = durableRowClaim,
): Promise<RefundCounts> =>
  underAttendeeClaim(
    rowClaim,
    batch.map((candidate) => candidate.attendee.id),
    provider.refundCapability,
    {
      blocked: (reason) => {
        for (const candidate of batch) {
          logError({
            code: ErrorCode.PAYMENT_REFUND,
            detail: `Admin bulk refund not started for attendee ${candidate.attendee.id}: ${reason}`,
            listingId,
          });
        }
        return { errorCount: 0, failedCount: batch.length, refundedCount: 0 };
      },
      lost: (counts) => counts.errorCount > 0,
      work: () => refundClaimedBatch(provider, batch, listingId),
    },
  );

const refundClaimedBatch = async (
  provider: RefundProvider,
  batch: RefundCandidate[],
  listingId: number,
): Promise<RefundCounts> => {
  const counts: RefundCounts = {
    errorCount: 0,
    failedCount: 0,
    refundedCount: 0,
  };
  for (const group of packByReferenceCount(PROVIDER_REFUND_CONCURRENCY)(
    batch,
  )) {
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
    for (const [attendeeId, ok] of posted) {
      if (ok) {
        counts.refundedCount++;
      } else {
        // The provider sent this refund but our ledger could not record it —
        // report the broken promise per attendee, not just the aggregate count.
        counts.errorCount++;
        reportRefundNotRecorded({ attendeeId, listingId });
      }
    }
  }
  return counts;
};
