/* jscpd:ignore-start -- imports */
import { groupToMap, requiredMapValue, uniqueBy } from "#fp";
import {
  markPaymentReferencesProviderRefunded,
  type RefundPaymentReference,
} from "#shared/db/payment-references.ts";
import {
  type ArmRefundDispatchResult,
  armRefundDispatch,
} from "#shared/db/payment-refund-dispatch.ts";
import { reportRefundNotRecorded } from "#shared/invariant-errors.ts";
import { ErrorCode, logError } from "#shared/logger.ts";
import { recordAttendeeRefundsBatch } from "#shared/refund-ledger/record.ts";
import { BULK_REFUND_LIMIT } from "#shared/subrequest-budget.ts";
import {
  type CandidateRefund,
  type PreparedReferenceRefund,
  refundReadyCandidate,
} from "./attempt.ts";
import type { RefundCandidate } from "./candidates.ts";
import {
  durableRowClaim,
  type HeldRefundWork,
  type RowClaim,
  type RunFindings,
} from "./claim.ts";
import { applyRefundLedgerFindings } from "./ledger-findings.ts";
import { PROVIDER_REFUND_CONCURRENCY } from "./provider-requests.ts";
import { recordProviderReviewFindings } from "./provider-reviews.ts";
import {
  prepareRefundReadiness,
  type ReadyRefundCandidate,
} from "./readiness.ts";
import { runRefundReadiness } from "./readiness-run.ts";
import { reportRefundProblem } from "./report.ts";
import { packByReferenceCount, type RefundOutcome } from "./waves.ts";

/* jscpd:ignore-end */

type RecordRefunds = typeof recordAttendeeRefundsBatch;
type ReturnedReference = CandidateRefund["returned"][number];
type MarkReturnedReferences = (
  references: readonly ReturnedReference[],
) => Promise<void>;

export type RefundCounts = {
  refundedCount: number;
  /** The provider accepted the refund but has not proved it completed. */
  pendingCount: number;
  failedCount: number;
  /** The provider was asked and did not give a clear answer. */
  errorCount: number;
  /** The money went back and the ledger could not record it. */
  notRecordedCount: number;
};

/** A batch either ran and has per-attendee tallies, or never started because
 *  another live refund owns part of its complete set. */
export type RefundBatchResult =
  | { kind: "blocked"; reason: "refund_in_progress" }
  | { counts: RefundCounts; kind: "finished" }
  | { counts: RefundCounts; kind: "not_ready"; message: string };

const noRefunds = (failedCount = 0): RefundCounts => ({
  errorCount: 0,
  failedCount,
  notRecordedCount: 0,
  pendingCount: 0,
  refundedCount: 0,
});

const finished = (counts: RefundCounts): RefundBatchResult => ({
  counts,
  kind: "finished",
});

const notReady = (
  counts: RefundCounts,
  message: string,
): RefundBatchResult => ({ counts, kind: "not_ready", message });

const logBulkRefundProblem = (
  outcome: Extract<RefundOutcome, "errored" | "failed">,
  candidate: ReadyRefundCandidate,
  listingId: number,
): void => {
  const refs = candidate.references
    .map(({ reference }) => reference.reference)
    .join(", ");
  logError({
    code: ErrorCode.PAYMENT_REFUND,
    detail: `Admin bulk refund ${outcome} for attendee ${candidate.attendee.id}, payments ${refs}`,
    listingId,
  });
};

/** An attendee's charges that came back, and whether that was all of them. */
type LedgerPosting = {
  readonly attendeeId: number;
  readonly references: readonly RefundPaymentReference[];
  readonly whole: boolean;
};

const tallyProviderRefund = (
  counts: RefundCounts,
  result: CandidateRefund,
  listingId: number,
  postings: LedgerPosting[],
): void => {
  const { candidate, outcome, returned } = result;
  if (outcome === "errored") {
    counts.errorCount++;
    logBulkRefundProblem(outcome, candidate, listingId);
  } else if (outcome === "failed") {
    counts.failedCount++;
    logBulkRefundProblem(outcome, candidate, listingId);
  } else if (outcome === "pending") {
    counts.pendingCount++;
  } else if (outcome === "withheld") {
    counts.failedCount++;
  }
  // Record whatever came back, even when a sibling charge did not.
  if (returned.length > 0) {
    postings.push({
      attendeeId: candidate.attendee.id,
      references: returned,
      whole: outcome === "refunded",
    });
  }
};

/** Post whatever came back for one wave, and retain any missed ledger write. */
const recordWave = async (
  record: RecordRefunds,
  counts: RefundCounts,
  postings: readonly LedgerPosting[],
  findings: RunFindings,
  listingId: number,
): Promise<void> => {
  const results = await record(postings);
  for (const { attendeeId, references, whole } of postings) {
    const result = requiredMapValue(
      results,
      attendeeId,
      `Refund ledger omitted attendee ${attendeeId}`,
    );
    const applied = applyRefundLedgerFindings(
      findings,
      attendeeId,
      references,
      result,
    );
    if (applied.hasUnrecorded) {
      counts.notRecordedCount++;
      reportRefundNotRecorded({ attendeeId, listingId });
    } else if (applied.allRecorded && whole) {
      counts.refundedCount++;
    }
  }
};

const markerFailure = (
  result: CandidateRefund,
  error: unknown,
  listingId: number,
): CandidateRefund => {
  if (result.returned.length === 0) return result;
  reportRefundProblem(
    `Admin refund could not record returned payments for attendee ${result.candidate.attendee.id}: ${String(
      error,
    )}`,
    listingId,
  );
  return {
    ...result,
    doubt: "in_doubt",
    outcome: result.outcome === "refunded" ? result.outcome : "errored",
  };
};

/** Mark all returned references from one provider wave in one ordered write. */
const markReturnedWave = async (
  markReturned: MarkReturnedReferences,
  results: readonly CandidateRefund[],
  listingId: number,
): Promise<CandidateRefund[]> => {
  const references = uniqueBy(
    (reference: ReturnedReference) => reference.index,
  )(results.flatMap(({ returned }) => [...returned]));
  if (references.length === 0) return [...results];
  try {
    await markReturned(references);
    return [...results];
  } catch (error) {
    return results.map((result) => markerFailure(result, error, listingId));
  }
};

/** Boundaries a refund run crosses after its candidate list is loaded. */
export type RefundRunDependencies = {
  arm?: typeof armRefundDispatch;
  claim?: RowClaim;
  markReturned?: MarkReturnedReferences;
  prepare?: typeof prepareRefundReadiness;
  record?: RecordRefunds;
};

type RefundStateWrites = {
  arm: typeof armRefundDispatch;
  markReturned: MarkReturnedReferences;
};

/** Keep local payment-state writes in order while provider calls overlap. */
const orderedRefundStateWrites = (
  writes: RefundStateWrites,
): RefundStateWrites => {
  const queue: { tail: Promise<void> } = { tail: Promise.resolve() };
  const afterPrevious = <T>(write: () => Promise<T>): Promise<T> => {
    const running = queue.tail.then(write);
    queue.tail = running.then(
      () => undefined,
      () => undefined,
    );
    return running;
  };
  return {
    arm: (request) => afterPrevious(() => writes.arm(request)),
    markReturned: (references) =>
      afterPrevious(() => writes.markReturned(references)),
  };
};

export const processRefundBatch = async (
  candidates: RefundCandidate[],
  listingId: number,
  {
    arm = armRefundDispatch,
    claim: rowClaim = durableRowClaim,
    markReturned:
      markReturnedReferences = markPaymentReferencesProviderRefunded,
    prepare = prepareRefundReadiness,
    record = recordAttendeeRefundsBatch,
  }: RefundRunDependencies = {},
): Promise<RefundBatchResult> =>
  await runRefundReadiness<RefundBatchResult>({
    action: "refund",
    candidates,
    changedMessage:
      "The attendee or payment set changed while this refund was starting. Try again.",
    claim: rowClaim,
    executionLimit: BULK_REFUND_LIMIT,
    label: "Admin bulk refund",
    listingId,
    notReady: (message) =>
      notReady(
        noRefunds(Math.min(candidates.length, BULK_REFUND_LIMIT)),
        message,
      ),
    prepare,
    ready: async (candidates, { claim, findings }) =>
      finished(
        await refundClaimedBatch(
          candidates,
          listingId,
          { markReturned: markReturnedReferences, record },
          findings,
          claim,
          arm,
        ),
      ),
  });

const refundClaimedBatch = async (
  batch: ReadyRefundCandidate[],
  listingId: number,
  writes: { markReturned: MarkReturnedReferences; record: RecordRefunds },
  findings: RunFindings,
  claim: HeldRefundWork["claim"],
  arm: typeof armRefundDispatch,
): Promise<RefundCounts> => {
  const stateWrites = orderedRefundStateWrites({
    arm,
    markReturned: writes.markReturned,
  });
  const inFlight = new Map<string, Promise<PreparedReferenceRefund>>();
  const attendeesByReference = groupToMap(
    (entry: { attendeeId: number; index: string }) => entry.index,
    (entry) => entry.attendeeId,
  )(
    batch.flatMap((candidate) =>
      candidate.references.map(({ reference }) => ({
        attendeeId: candidate.attendee.id,
        index: reference.index,
      })),
    ),
  );
  const authorize = async (
    indexes: readonly string[],
  ): Promise<ArmRefundDispatchResult> => {
    const result = await stateWrites.arm({ ...claim, indexes });
    if (result.kind === "armed") {
      for (const [sessionId, phase] of result.phases) {
        findings.claimPhases.set(sessionId, phase);
      }
      for (const index of indexes) {
        for (const attendeeId of requiredMapValue(
          attendeesByReference,
          index,
          `Refund dispatch lost payment ${index}'s attendees`,
        )) {
          findings.doubts.set(attendeeId, "in_doubt");
        }
      }
    }
    return result;
  };
  const counts = noRefunds();
  for (const group of packByReferenceCount(PROVIDER_REFUND_CONCURRENCY)(
    batch,
  )) {
    const providerResults = await Promise.all(
      group.map((candidate) =>
        refundReadyCandidate(candidate, listingId, authorize, inFlight),
      ),
    );
    const results = await markReturnedWave(
      stateWrites.markReturned,
      providerResults,
      listingId,
    );
    const postings: LedgerPosting[] = [];
    for (const result of results) {
      if (result.doubt !== undefined) {
        findings.doubts.set(result.candidate.attendee.id, result.doubt);
      } else {
        findings.doubts.delete(result.candidate.attendee.id);
      }
      recordProviderReviewFindings(findings, result.reviews);
      tallyProviderRefund(counts, result, listingId, postings);
    }
    await recordWave(writes.record, counts, postings, findings, listingId);
  }
  return counts;
};
