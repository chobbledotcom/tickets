import type { AnchoredAttendee } from "#shared/db/payment-anchor/mint.ts";
import { anchorSessionId } from "#shared/db/payment-anchor/session.ts";
import {
  markPaymentReferencesProviderRefunded,
  type RefundPaymentReference,
} from "#shared/db/payment-references.ts";
import { reportRefundNotRecorded } from "#shared/invariant-errors.ts";
import { ErrorCode, logError } from "#shared/logger.ts";
import type { ResolvedRefundCapability } from "#shared/payment/row-state.ts";
import { recordAttendeeRefundsBatch } from "#shared/refund-ledger.ts";
import {
  type CandidateRefund,
  type MarkReturnedReferences,
  type PreparedReferenceRefund,
  type RefundProvider,
  refundCandidateAtProvider,
} from "./attempt.ts";
import type { RefundCandidate } from "./candidates.ts";
import {
  durableRowClaim,
  type RefundRunBlock,
  type RowClaim,
  type RunFindings,
  underAttendeeClaim,
} from "./claim.ts";
import { reportRefundProblem } from "./report.ts";
import { PROVIDER_REFUND_CONCURRENCY } from "./provider-requests.ts";
import { packByReferenceCount, type RefundOutcome } from "./waves.ts";

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
  | { counts: RefundCounts; kind: "finished" };

const noRefunds = (failedCount = 0): RefundCounts => ({
  errorCount: 0,
  failedCount,
  notRecordedCount: 0,
  pendingCount: 0,
  refundedCount: 0,
});

const BLOCK_IS_SETTLING = {
  claim_held: true,
  payment_set_changed: false,
} as const satisfies Record<RefundRunBlock["kind"], boolean>;

const finished = (counts: RefundCounts): RefundBatchResult => ({
  counts,
  kind: "finished",
});

const logBulkRefundProblem = (
  outcome: Extract<RefundOutcome, "errored" | "failed">,
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

/** The rows this charge is held by. */
const rowsHolding = (
  attendeeId: number,
  reference: RefundPaymentReference,
): readonly string[] =>
  reference.rowSessionIds.length > 0
    ? reference.rowSessionIds
    : [anchorSessionId(attendeeId, reference.index)];

/** Post whatever came back for one wave, and retain any missed ledger write. */
const recordWave = async (
  record: RecordRefunds,
  counts: RefundCounts,
  postings: readonly LedgerPosting[],
  findings: RunFindings,
  listingId: number,
): Promise<void> => {
  const posted = await record(postings);
  for (const { attendeeId, references, whole } of postings) {
    if (posted.get(attendeeId) !== true) {
      counts.notRecordedCount++;
      reportRefundNotRecorded({ attendeeId, listingId });
      const missedRows = references.flatMap((reference) =>
        rowsHolding(attendeeId, reference),
      );
      const earlierMissedRows = findings.unrecorded.get(attendeeId);
      findings.unrecorded.set(
        attendeeId,
        earlierMissedRows === undefined
          ? missedRows
          : [...earlierMissedRows, ...missedRows],
      );
    } else if (whole) {
      counts.refundedCount++;
    }
  }
};

/** The writes a run makes away from the provider. */
export type RefundWrites = {
  claim?: RowClaim;
  markReturned?: MarkReturnedReferences;
  record?: RecordRefunds;
};

export const processRefundBatch = async (
  provider: RefundProvider,
  batch: RefundCandidate[],
  listingId: number,
  {
    claim: rowClaim = durableRowClaim,
    markReturned:
      markReturnedReferences = markPaymentReferencesProviderRefunded,
    record = recordAttendeeRefundsBatch,
  }: RefundWrites = {},
): Promise<RefundBatchResult> =>
  await underAttendeeClaim<RefundBatchResult>(
    rowClaim,
    batch.map((candidate) => ({
      attendeeId: candidate.attendee.id,
      loadedPiiBlob: candidate.attendee.pii_blob,
      references: candidate.references,
    })),
    provider.refundCapability,
    listingId,
    {
      blocked: ({ kind, reason }) => {
        if (BLOCK_IS_SETTLING[kind]) {
          return { kind: "blocked", reason: "refund_in_progress" };
        }
        for (const candidate of batch) {
          reportRefundProblem(
            `Admin bulk refund not started for attendee ${candidate.attendee.id}: ${reason}`,
            listingId,
          );
        }
        return finished(noRefunds(batch.length));
      },
      work: async (alreadyReturned, findings, inherited) =>
        finished(
          await refundClaimedBatch(
            provider,
            batch,
            listingId,
            { markReturned: markReturnedReferences, record },
            alreadyReturned,
            findings,
            inherited,
          ),
        ),
    },
  );

const refundClaimedBatch = async (
  provider: RefundProvider,
  batch: RefundCandidate[],
  listingId: number,
  writes: { markReturned: MarkReturnedReferences; record: RecordRefunds },
  alreadyReturned: ReadonlySet<string>,
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
        candidate.references.map((reference) => reference.reference),
      ),
  );
  const counts = noRefunds();
  for (const group of packByReferenceCount(PROVIDER_REFUND_CONCURRENCY)(
    batch,
  )) {
    const results = await Promise.all(
      group.map((candidate) =>
        refundCandidateAtProvider(
          provider,
          candidate,
          listingId,
          writes.markReturned,
          alreadyReturned,
          inFlight,
          observeOnly,
        ),
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
