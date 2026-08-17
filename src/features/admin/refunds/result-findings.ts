import type { CandidateRefund } from "./attempt.ts";
import type { RunFindings } from "./claim.ts";
import { rememberFailedRefundLedger } from "./ledger-findings.ts";

/** Preserve one complete candidate answer for claim settlement. */
export const rememberCandidateFindings = (
  findings: RunFindings,
  result: CandidateRefund,
): void => {
  const attendeeId = result.candidate.attendee.id;
  if (result.returned.length > 0) {
    rememberFailedRefundLedger(
      findings,
      attendeeId,
      result.returned.map(({ reference }) => reference),
    );
  }
};
