import type { RefundPaymentReference } from "#shared/db/payment-references.ts";
import type { RefundLedgerResult } from "#shared/refund-ledger/result.ts";
import type { RunFindings } from "./claim.ts";

export type AppliedRefundLedgerFindings = {
  readonly allRecorded: boolean;
  readonly hasUnrecorded: boolean;
  readonly needsReview: boolean;
};

const matchingReferences = (
  references: readonly RefundPaymentReference[],
  indexes: ReadonlySet<string>,
): RefundPaymentReference[] =>
  references.filter(({ index }) => indexes.has(index));

const referenceRows = (
  references: readonly RefundPaymentReference[],
): string[] => references.flatMap((reference) => reference.rowSessionIds);

const addUnrecordedRows = (
  findings: RunFindings,
  attendeeId: number,
  rows: readonly string[],
): void => {
  if (rows.length === 0) return;
  findings.unrecorded.set(attendeeId, [
    ...new Set([...(findings.unrecorded.get(attendeeId) ?? []), ...rows]),
  ]);
};

/** Put one exact ledger result onto the rows that carried each reference. */
export const applyRefundLedgerFindings = (
  findings: RunFindings,
  attendeeId: number,
  references: readonly RefundPaymentReference[],
  result: RefundLedgerResult,
): AppliedRefundLedgerFindings => {
  const recorded = matchingReferences(references, result.recorded);
  const unrecorded = matchingReferences(references, result.unrecorded);
  const review = matchingReferences(references, result.reviewReferenceIndexes);
  for (const sessionId of referenceRows(recorded)) {
    findings.recorded.add(sessionId);
  }
  addUnrecordedRows(findings, attendeeId, referenceRows(unrecorded));
  for (const sessionId of referenceRows(review)) {
    findings.reviews.set(sessionId, {
      kind: "review",
      reason: { kind: "partially_returned_obligation" },
    });
  }
  return {
    allRecorded: recorded.length === references.length,
    hasUnrecorded: unrecorded.length > 0,
    needsReview: review.length > 0,
  };
};
