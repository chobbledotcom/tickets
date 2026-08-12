import type { RefundPaymentReference } from "#shared/db/payment-references.ts";
import {
  type RefundLedgerResult,
  refundLedgerResult,
} from "#shared/refund-ledger/result.ts";
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

const updateUnrecordedRows = (
  findings: RunFindings,
  attendeeId: number,
  update: (current: readonly string[]) => readonly string[],
): void => {
  const updated = update(findings.unrecorded.get(attendeeId) ?? []);
  if (updated.length === 0) {
    findings.unrecorded.delete(attendeeId);
  } else {
    findings.unrecorded.set(attendeeId, updated);
  }
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
  const recordedRows = referenceRows(recorded);
  const reviewRows = referenceRows(review);
  const clearing = new Set([...recordedRows, ...reviewRows]);
  updateUnrecordedRows(findings, attendeeId, (current) =>
    current.filter((sessionId) => !clearing.has(sessionId)),
  );
  for (const sessionId of recordedRows) {
    findings.recorded.add(sessionId);
  }
  const missedRows = referenceRows(unrecorded);
  updateUnrecordedRows(findings, attendeeId, (current) => [
    ...new Set([...current, ...missedRows]),
  ]);
  for (const sessionId of reviewRows) {
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

/** Preserve every returned row when the ledger produced no usable answer. */
export const rememberFailedRefundLedger = (
  findings: RunFindings,
  attendeeId: number,
  references: readonly RefundPaymentReference[],
): void => {
  applyRefundLedgerFindings(
    findings,
    attendeeId,
    references,
    refundLedgerResult(references),
  );
};
