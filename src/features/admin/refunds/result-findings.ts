import type { CandidateRefund } from "./attempt.ts";
import type { RunFindings } from "./claim.ts";
import { rememberFailedRefundLedger } from "./ledger-findings.ts";
import { recordProviderReviewFindings } from "./provider-reviews.ts";

export type RefundFindingPolicy = {
  /** Keep, add to, or replace protection around this attendee. */
  readonly doubt: "keep" | "merge" | "replace";
};

type ResultDoubt = CandidateRefund["doubt"];
type RememberDoubt = (
  findings: RunFindings,
  attendeeId: number,
  doubt: ResultDoubt,
) => void;

const addDoubt: RememberDoubt = (findings, attendeeId, doubt) => {
  if (doubt !== undefined) findings.doubts.set(attendeeId, doubt);
};

const REMEMBER_DOUBT = {
  keep: (
    _findings: RunFindings,
    _attendeeId: number,
    _doubt: ResultDoubt,
  ) => {},
  merge: addDoubt,
  replace: (findings: RunFindings, attendeeId: number, doubt: ResultDoubt) => {
    if (doubt === undefined) {
      findings.doubts.delete(attendeeId);
    } else {
      addDoubt(findings, attendeeId, doubt);
    }
  },
} satisfies Record<RefundFindingPolicy["doubt"], RememberDoubt>;

/** Preserve one complete candidate answer for claim settlement. */
export const rememberCandidateFindings = (
  findings: RunFindings,
  result: CandidateRefund,
  policy: RefundFindingPolicy,
): void => {
  const attendeeId = result.candidate.attendee.id;
  if (result.returned.length > 0) {
    rememberFailedRefundLedger(findings, attendeeId, result.returned);
  }
  REMEMBER_DOUBT[policy.doubt](findings, attendeeId, result.doubt);
  recordProviderReviewFindings(findings, result.reviews);
};
