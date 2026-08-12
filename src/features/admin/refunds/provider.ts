/* jscpd:ignore-start -- imports */
import { requiredMapValue, uniqueBy } from "#fp";
import {
  markPaymentReferencesProviderRefunded,
  type RefundPaymentReference,
} from "#shared/db/payment-references.ts";
import { armRefundDispatch } from "#shared/db/payment-refund-dispatch.ts";
import { reportRefundNotRecorded } from "#shared/invariant-errors.ts";
import {
  ErrorCode,
  logError,
  withDeferredErrorReports,
} from "#shared/logger.ts";
import { recordAttendeeRefundsBatch } from "#shared/refund-ledger/record.ts";
import {
  BULK_REFUND_LIMIT,
  withSubrequestReserve,
} from "#shared/subrequest-budget.ts";
import type { CandidateRefund } from "./attempt.ts";
import {
  REFUND_BUDGET_MESSAGES,
  REFUND_CALLER_SUBREQUEST_RESERVE,
  type RefundBudgetAudience,
} from "./budget.ts";
import type { RefundCandidate } from "./candidates.ts";
import { durableRowClaim, type RowClaim, type RunFindings } from "./claim.ts";
import { dispatchRefundBatch } from "./dispatch.ts";
import {
  applyRefundLedgerFindings,
  rememberFailedRefundLedger,
} from "./ledger-findings.ts";
import {
  prepareRefundReadiness,
  type ReadyRefundCandidate,
} from "./readiness.ts";
import { runRefundReadiness } from "./readiness-run.ts";
import { reportRefundProblem } from "./report.ts";
import { rememberCandidateFindings } from "./result-findings.ts";
import type { RefundOutcome } from "./waves.ts";

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
  | {
      counts: RefundCounts;
      kind: "not_ready";
      message: string;
      reason?: "subrequest_budget";
    };

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
  reason?: "subrequest_budget",
): RefundBatchResult => ({
  counts,
  kind: "not_ready",
  message,
  ...(reason === undefined ? {} : { reason }),
});

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
  let results: Awaited<ReturnType<RecordRefunds>>;
  try {
    results = await record(postings);
  } catch (error) {
    for (const { attendeeId, references } of postings) {
      rememberFailedRefundLedger(findings, attendeeId, references);
    }
    throw error;
  }
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
  audience?: RefundBudgetAudience;
  claim?: RowClaim;
  markReturned?: MarkReturnedReferences;
  prepare?: typeof prepareRefundReadiness;
  record?: RecordRefunds;
};

export const processRefundBatch = async (
  candidates: RefundCandidate[],
  listingId: number,
  {
    arm = armRefundDispatch,
    audience = "bulk",
    claim: rowClaim = durableRowClaim,
    markReturned:
      markReturnedReferences = markPaymentReferencesProviderRefunded,
    prepare = prepareRefundReadiness,
    record = recordAttendeeRefundsBatch,
  }: RefundRunDependencies = {},
): Promise<RefundBatchResult> =>
  await withSubrequestReserve(REFUND_CALLER_SUBREQUEST_RESERVE, () =>
    withDeferredErrorReports(() =>
      runRefundReadiness<RefundBatchResult>({
        action: "refund",
        budgetAudience: audience,
        candidates,
        changedMessage:
          "The attendee or payment set changed while this refund was starting. Try again.",
        claim: rowClaim,
        executionLimit: BULK_REFUND_LIMIT,
        label: "Admin bulk refund",
        listingId,
        notReady: (message, reason) =>
          notReady(
            noRefunds(
              reason === "subrequest_budget"
                ? candidates.length
                : Math.min(candidates.length, BULK_REFUND_LIMIT),
            ),
            message,
            reason,
          ),
        prepare,
        ready: async (readyCandidates, held) => {
          const dispatched = await dispatchRefundBatch(
            readyCandidates,
            listingId,
            held,
            arm,
          );
          if (dispatched.kind === "budget_refused") {
            return notReady(
              noRefunds(candidates.length),
              REFUND_BUDGET_MESSAGES[audience],
              "subrequest_budget",
            );
          }
          return finished(
            await recordDispatchedBatch(
              dispatched.waves,
              listingId,
              { markReturned: markReturnedReferences, record },
              held.findings,
            ),
          );
        },
      }),
    ),
  );

const recordDispatchedBatch = async (
  waves: readonly (readonly CandidateRefund[])[],
  listingId: number,
  writes: { markReturned: MarkReturnedReferences; record: RecordRefunds },
  findings: RunFindings,
): Promise<RefundCounts> => {
  const counts = noRefunds();
  const remember = (result: CandidateRefund): void =>
    rememberCandidateFindings(findings, result, { doubt: "replace" });
  waves.flat().forEach(remember);
  for (const providerResults of waves) {
    const results = await markReturnedWave(
      writes.markReturned,
      providerResults,
      listingId,
    );
    const postings: LedgerPosting[] = [];
    for (const result of results) {
      remember(result);
      tallyProviderRefund(counts, result, listingId, postings);
    }
    await recordWave(writes.record, counts, postings, findings, listingId);
  }
  return counts;
};
