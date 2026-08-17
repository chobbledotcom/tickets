/* jscpd:ignore-start -- imports */
import { requiredMapValue } from "#fp";
import { reportRefundNotRecorded } from "#shared/invariant-errors.ts";
import { withDeferredErrorReports } from "#shared/logger.ts";
import {
  type RefundAuthorityReceipt,
  recordProviderRefunds,
  requestProviderRefund,
} from "#shared/provider-refunds.ts";
import { recordAttendeeRefundsBatch } from "#shared/refund-ledger/record.ts";
import type { CandidateRefund } from "./attempt.ts";
import {
  type AuthorityBearingReference,
  recordedRefundAuthorities,
} from "./authority.ts";
import { REFUND_BUDGET_MESSAGES, type RefundBudgetAudience } from "./budget.ts";
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
type TaggedRefundReference =
  ReadyRefundCandidate["references"][number]["reference"];

export type RefundCounts = {
  refundedCount: number;
  /** The provider accepted the refund but has not proved it completed. */
  pendingCount: number;
  failedCount: number;
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
  outcome: Extract<RefundOutcome, "failed">,
  candidate: ReadyRefundCandidate,
  listingId: number,
): void => {
  reportRefundProblem(
    {
      attendeeId: candidate.attendee.id,
      kind: "batch_outcome",
      outcome,
      paymentCount: candidate.references.length,
    },
    listingId,
  );
};

/** An attendee's charges that came back, and whether that was all of them. */
type LedgerPosting = {
  readonly authorities: readonly AuthorityBearingReference<TaggedRefundReference>[];
  readonly attendeeId: number;
  readonly references: readonly TaggedRefundReference[];
  readonly whole: boolean;
};

const tallyProviderRefund = (
  counts: RefundCounts,
  result: CandidateRefund,
  listingId: number,
  postings: LedgerPosting[],
): void => {
  const { candidate, outcome, returned } = result;
  if (outcome === "failed") {
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
      authorities: returned,
      references: returned.map(({ reference }) => reference),
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
  recordedAuthorities: RefundAuthorityReceipt[],
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
  for (const { attendeeId, authorities, references, whole } of postings) {
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
    recordedAuthorities.push(...recordedRefundAuthorities(authorities, result));
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
  audience?: RefundBudgetAudience;
  claim?: RowClaim;
  prepare?: typeof prepareRefundReadiness;
  record?: RecordRefunds;
  recordAuthorities?: typeof recordProviderRefunds;
  request?: typeof requestProviderRefund;
};

export const processRefundBatch = async (
  candidates: RefundCandidate[],
  listingId: number,
  {
    audience = "bulk",
    claim: rowClaim = durableRowClaim,
    prepare = prepareRefundReadiness,
    record = recordAttendeeRefundsBatch,
    recordAuthorities = recordProviderRefunds,
    request = requestProviderRefund,
  }: RefundRunDependencies = {},
): Promise<RefundBatchResult> =>
  await withDeferredErrorReports(() =>
    runRefundReadiness<RefundBatchResult>({
      action: "refund",
      budgetAudience: audience,
      candidates,
      changedMessage:
        "The attendee or payment set changed while this refund was starting. Try again.",
      claim: rowClaim,
      listingId,
      notReady: (message, reason) =>
        notReady(noRefunds(candidates.length), message, reason),
      prepare,
      ready: async (readyCandidates, held) => {
        const dispatched = await dispatchRefundBatch(
          readyCandidates,
          listingId,
          held,
          request,
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
            { record, recordAuthorities },
            held.findings,
          ),
        );
      },
      request,
    }),
  );

const recordDispatchedBatch = async (
  waves: readonly (readonly CandidateRefund[])[],
  listingId: number,
  writes: {
    record: RecordRefunds;
    recordAuthorities: typeof recordProviderRefunds;
  },
  findings: RunFindings,
): Promise<RefundCounts> => {
  const counts = noRefunds();
  const remember = (result: CandidateRefund): void =>
    rememberCandidateFindings(findings, result);
  const providerResults = waves.flat();
  const postings: LedgerPosting[] = [];
  for (const result of providerResults) {
    remember(result);
    tallyProviderRefund(counts, result, listingId, postings);
  }
  const recordedAuthorities: RefundAuthorityReceipt[] = [];
  await recordWave(
    writes.record,
    counts,
    postings,
    findings,
    listingId,
    recordedAuthorities,
  );
  await writes.recordAuthorities(recordedAuthorities);
  return counts;
};
