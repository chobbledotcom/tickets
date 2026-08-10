import { chunk } from "#fp";
import {
  type ClaimResult,
  claimAttendeeRows,
  releaseAttendeeRows,
} from "#shared/db/payment-claim.ts";
import {
  isLegacyMergeSession,
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

/** Say that something went wrong with a refund on this listing. */
const reportRefundProblem = (detail: string, listingId: number): void =>
  logError({ code: ErrorCode.PAYMENT_REFUND, detail, listingId });

/** Log why one reference's money did not move, and report it as failed. */
const refusedRefund = (detail: string, listingId: number): RefundOutcome => {
  reportRefundProblem(detail, listingId);
  return "failed";
};

/** One reference's result. `unanswered` means the provider was asked and did
 *  not confirm — which is not the same as "it did not happen": a lost response
 *  looks exactly like a refusal from here, so a keyless run must keep its hold
 *  either way. A refund we never asked for does not set it. */
type ReferenceRefund = { outcome: RefundOutcome; unanswered: boolean };

/**
 * Do the work at most once for each key, and give everyone the same answer.
 *
 * Two attendees in one run can carry the same charge, and the durable hold
 * cannot separate them because both rows belong to this same run — so the
 * second asker waits on the first's answer rather than making its own call.
 */
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

const refundReferenceOnce = async (
  provider: RefundProvider,
  candidate: RefundCandidate,
  listingId: number,
  reference: RefundPaymentReference,
  alreadyReturned: ReadonlySet<string>,
): Promise<ReferenceRefund> => {
  const attendeeId = candidate.attendee.id;
  const paymentReference = reference.reference;
  const settled = (outcome: RefundOutcome): ReferenceRefund => ({
    outcome,
    unanswered: false,
  });
  try {
    if (reference.refundState === "completed") return settled("refunded");
    // What the claimed row says now beats the reference list this run loaded
    // before it had the hold: another run may have refunded this since.
    if (alreadyReturned.has(reference.index)) return settled("refunded");
    // What the money has already done decides whether more is sent — see
    // `sendRefundIfAdmitted`. SumUp has no idempotency key to fall back on.
    return await sendRefundIfAdmitted(provider, paymentReference, {
      failed: () => ({
        outcome: refusedRefund(
          `Admin refund failed for attendee ${attendeeId}, payment ${paymentReference}`,
          listingId,
        ),
        // The provider was asked and did not confirm. It may never have
        // happened, or the answer may simply have been lost.
        unanswered: true,
      }),
      sent: () => settled("refunded"),
      withhold: (admission) =>
        settled(
          admission.kind === "already_returned"
            ? "refunded"
            : refusedRefund(
                `Admin refund not sent for attendee ${attendeeId}, payment ${paymentReference}: ${admissionReason(admission)}`,
                listingId,
              ),
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
    // A throw is the same doubt as an unconfirmed answer: the call may have
    // landed before it failed.
    return { outcome: "errored", unanswered: true };
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
/** Let go of a hold, reporting rather than raising when the row will not. */
const releaseHold = async (
  rowClaim: RowClaim,
  claim: { heldSince: string; sessionIds: readonly string[] },
  listingId: number,
): Promise<void> => {
  try {
    await rowClaim.release(claim.sessionIds, claim.heldSince);
  } catch (error) {
    reportRefundProblem(
      `Refund claim could not be released: ${String(error)}`,
      listingId,
    );
  }
};

export const underAttendeeClaim = async <TResult>(
  rowClaim: RowClaim,
  attendeeIds: readonly number[],
  capability: RefundCapability,
  listingId: number,
  run: {
    blocked: (reason: string) => TResult;
    /** The payment sessions this run loaded. A hold covering anything else
     *  means the attendee's money grew while the run was queued. */
    knownSessionIds: ReadonlySet<string>;
    lost: (result: TResult) => boolean;
    work: (alreadyReturned: ReadonlySet<string>) => Promise<TResult>;
  },
): Promise<TResult> => {
  const claim = await rowClaim.claim(attendeeIds, capability);
  if (claim.kind === "blocked") {
    return run.blocked(claimRefusal(claim.blockedBy));
  }
  // The hold covers the rows that exist NOW. If it covers a payment this run
  // never loaded — a balance settlement that landed while we queued — then
  // refunding what we did load would return part of someone's money and leave
  // the rest, so the whole run stands down and the operator tries again
  // against the complete set.
  // A merge anchor is not a new charge: the reference list leaves its id out
  // on purpose, so it would otherwise look like money that appeared while we
  // waited and stand every merged attendee's refund down for ever.
  const unknown = claim.sessionIds.filter(
    (sessionId) =>
      !run.knownSessionIds.has(sessionId) && !isLegacyMergeSession(sessionId),
  );
  if (unknown.length > 0) {
    await releaseHold(rowClaim, claim, listingId);
    return run.blocked(
      `a payment landed while this run was waiting (${unknown.length} not in the set it loaded)`,
    );
  }
  // A release that fails leaves the claim standing until it goes stale, which
  // is recoverable. Losing the answer the run just produced is not, so a
  // release failure is reported and never allowed to replace the result or the
  // original error.
  const release = async (lost: boolean): Promise<void> => {
    if (!mayReleaseClaim(capability, lost ? "lost" : "validated")) return;
    await releaseHold(rowClaim, claim, listingId);
  };
  try {
    const result = await run.work(claim.returned);
    await release(run.lost(result));
    return result;
  } catch (error) {
    await release(true);
    throw error;
  }
};

/** What one attendee's refund came to. `unsettled` means nothing durable
 *  proves what the money did — the provider was asked and did not confirm, or
 *  it confirmed and saying so failed. Either way the run keeps its hold, since
 *  a keyless retry against evidence that has not caught up sends twice. */
export type CandidateRefund = {
  candidate: RefundCandidate;
  outcome: RefundOutcome;
  unsettled?: boolean;
};

export const refundCandidateAtProvider = async (
  provider: RefundProvider,
  candidate: RefundCandidate,
  listingId: number,
  markReturnedReferences: MarkReturnedReferences = markPaymentReferencesProviderRefunded,
  alreadyReturned: ReadonlySet<string> = new Set(),
  inFlight: Map<string, Promise<ReferenceRefund>> = new Map(),
): Promise<CandidateRefund> => {
  const results: {
    outcome: RefundOutcome;
    reference: RefundPaymentReference;
    unanswered: boolean;
  }[] = [];
  // Chunk this attendee's own references so a merged attendee carrying many
  // charges never fans out past the concurrency budget on its own.
  for (const group of chunk(PROVIDER_REFUND_CONCURRENCY)(
    candidate.references,
  )) {
    const groupResults = await Promise.all(
      group.map(async (reference) => ({
        ...(await answeredOnce(inFlight, reference.reference, () =>
          refundReferenceOnce(
            provider,
            candidate,
            listingId,
            reference,
            alreadyReturned,
          ),
        )),
        reference,
      })),
    );
    results.push(...groupResults);
  }
  const outcome = combineRefundOutcomes(
    results.map((result) => result.outcome),
  );
  const unanswered = results.some((result) => result.unanswered);
  const returnedReferences = results
    .filter((result) => result.outcome === "refunded")
    .map((result) => result.reference);
  try {
    await markReturnedReferences(returnedReferences);
  } catch (error) {
    reportRefundProblem(
      `Admin refund could not record returned payments for attendee ${candidate.attendee.id}: ${String(error)}`,
      listingId,
    );
    if (outcome !== "refunded") return { candidate, outcome: "errored" };
    // The money went back but nothing records it. The refund still counts, so
    // the ledger still posts — but the run must not let go of its hold.
    return { candidate, outcome, unsettled: true };
  }
  if (outcome !== "refunded" && candidate.references.length > 1) {
    logError({
      code: ErrorCode.PAYMENT_REFUND,
      detail: `Admin refund did not complete every payment for attendee ${candidate.attendee.id}`,
      listingId,
    });
  }
  return unanswered
    ? { candidate, outcome, unsettled: true }
    : { candidate, outcome };
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
  markReturnedReferences: MarkReturnedReferences = markPaymentReferencesProviderRefunded,
): Promise<RefundCounts> => {
  const result = await underAttendeeClaim(
    rowClaim,
    batch.map((candidate) => candidate.attendee.id),
    provider.refundCapability,
    listingId,
    {
      blocked: (reason) => {
        for (const candidate of batch) {
          reportRefundProblem(
            `Admin bulk refund not started for attendee ${candidate.attendee.id}: ${reason}`,
            listingId,
          );
        }
        return {
          counts: {
            errorCount: 0,
            failedCount: batch.length,
            refundedCount: 0,
          },
          unsettled: false,
        };
      },
      knownSessionIds: new Set(
        batch.flatMap((candidate) =>
          candidate.references.flatMap((reference) => [
            ...reference.sessionIds,
          ]),
        ),
      ),
      lost: (result) => result.counts.errorCount > 0 || result.unsettled,
      work: (alreadyReturned) =>
        refundClaimedBatch(
          provider,
          batch,
          listingId,
          markReturnedReferences,
          alreadyReturned,
        ),
    },
  );
  return result.counts;
};

const refundClaimedBatch = async (
  provider: RefundProvider,
  batch: RefundCandidate[],
  listingId: number,
  markReturnedReferences: MarkReturnedReferences,
  alreadyReturned: ReadonlySet<string>,
): Promise<{ counts: RefundCounts; unsettled: boolean }> => {
  let unsettled = false;
  // Shared across the whole run, so a charge two attendees both carry is asked
  // about once.
  const inFlight = new Map<string, Promise<ReferenceRefund>>();
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
        refundCandidateAtProvider(
          provider,
          candidate,
          listingId,
          markReturnedReferences,
          alreadyReturned,
          inFlight,
        ),
      ),
    );
    const chunkRefundedAttendees: {
      attendeeId: number;
      references: readonly RefundPaymentReference[];
    }[] = [];
    for (const { candidate, outcome, unsettled: doubt } of results) {
      if (doubt === true) unsettled = true;
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
  return { counts, unsettled };
};
