/* jscpd:ignore-start -- imports */
import { requiredMapValue } from "#fp";
import type { AnchoredAttendee } from "#shared/db/payment-anchor/mint.ts";
import { markPaymentReferencesProviderRefunded } from "#shared/db/payment-references.ts";
import { reportRefundNotRecorded } from "#shared/invariant-errors.ts";
import { ErrorCode, logError } from "#shared/logger.ts";
import type { ResolvedRefundCapability } from "#shared/payment/row-state.ts";
import { recordAttendeeRefundsBatch } from "#shared/refund-ledger.ts";
import {
  type CandidateRefund,
  type MarkReturnedReferences,
  type PreparedReferenceRefund,
  refundReadyCandidate,
} from "./attempt.ts";
import type { RefundCandidate } from "./candidates.ts";
import { durableRowClaim, type RowClaim, type RunFindings } from "./claim.ts";
import { applyRefundLedgerFindings } from "./ledger-findings.ts";
import { PROVIDER_REFUND_CONCURRENCY } from "./provider-requests.ts";
import {
  prepareRefundReadiness,
  type ReadyRefundCandidate,
} from "./readiness.ts";
import { runRefundReadiness } from "./readiness-run.ts";
import { packByReferenceCount, type RefundOutcome } from "./waves.ts";

/* jscpd:ignore-end */

type RecordRefunds = typeof recordAttendeeRefundsBatch;

/** Whether a stale run can safely repeat the provider call it inherited. */
const MAY_RETRY_INHERITED_CALL = {
  keyed: true,
  keyless: false,
} as const satisfies Record<ResolvedRefundCapability, boolean>;

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
    detail:
      `Admin bulk refund ${outcome} for attendee ${candidate.attendee.id}, payments ${refs}`,
    listingId,
  });
};

/** An attendee's charges that came back, and whether that was all of them. */
type LedgerPosting = AnchoredAttendee & { whole: boolean };

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

/** Boundaries a refund run crosses after its candidate list is loaded. */
export type RefundRunDependencies = {
  claim?: RowClaim;
  markReturned?: MarkReturnedReferences;
  prepare?: typeof prepareRefundReadiness;
  record?: RecordRefunds;
};

export const processRefundBatch = async (
  batch: RefundCandidate[],
  listingId: number,
  {
    claim: rowClaim = durableRowClaim,
    markReturned: markReturnedReferences =
      markPaymentReferencesProviderRefunded,
    prepare = prepareRefundReadiness,
    record = recordAttendeeRefundsBatch,
  }: RefundRunDependencies = {},
): Promise<RefundBatchResult> =>
  await runRefundReadiness<RefundBatchResult>({
    candidates: batch,
    changedMessage:
      "The attendee or payment set changed while this refund was starting. Try again.",
    claim: rowClaim,
    label: "Admin bulk refund",
    listingId,
    notReady: (message) => notReady(noRefunds(batch.length), message),
    prepare,
    ready: async (candidates, { findings, inherited }) =>
      finished(
        await refundClaimedBatch(
          candidates,
          listingId,
          { markReturned: markReturnedReferences, record },
          findings,
          inherited,
        ),
      ),
  });

const refundClaimedBatch = async (
  batch: ReadyRefundCandidate[],
  listingId: number,
  writes: { markReturned: MarkReturnedReferences; record: RecordRefunds },
  findings: RunFindings,
  inherited: ReadonlyMap<number, ResolvedRefundCapability>,
): Promise<RefundCounts> => {
  const inFlight = new Map<string, Promise<PreparedReferenceRefund>>();
  const observeOnly = new Set(
    batch
      .filter((candidate) => {
        const capability = inherited.get(candidate.attendee.id);
        return (
          capability !== undefined && !MAY_RETRY_INHERITED_CALL[capability]
        );
      })
      .flatMap((candidate) =>
        candidate.references.map(({ reference }) => reference.index)
      ),
  );
  const counts = noRefunds();
  for (
    const group of packByReferenceCount(PROVIDER_REFUND_CONCURRENCY)(
      batch,
    )
  ) {
    const results = await Promise.all(
      group.map((candidate) =>
        refundReadyCandidate(
          candidate,
          listingId,
          writes.markReturned,
          inFlight,
          observeOnly,
        )
      ),
    );
    const postings: LedgerPosting[] = [];
    for (const result of results) {
      if (result.doubt !== undefined) {
        findings.doubts.set(result.candidate.attendee.id, result.doubt);
      }
      tallyProviderRefund(counts, result, listingId, postings);
    }
    await recordWave(writes.record, counts, postings, findings, listingId);
  }
  return counts;
};
