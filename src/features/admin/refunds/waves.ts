import type { PaymentRefundResult } from "#shared/payments.ts";
import type { RefundCandidate } from "./candidates.ts";

/** The result of attempting to refund one charge reference (or a whole
 * candidate, once its per-reference outcomes are combined). */
export type RefundOutcome = PaymentRefundResult | "errored";

/** Pack candidates into waves whose combined charge references stay within
 * `budget`, so each concurrently-processed wave issues at most ~`budget`
 * provider subrequests. A single candidate carrying more references than the
 * budget forms its own wave; its references are chunked inside
 * `refundCandidateAtProvider`. */
export const packByReferenceCount =
  (budget: number) =>
  (candidates: RefundCandidate[]): RefundCandidate[][] => {
    const waves: RefundCandidate[][] = [];
    let currentCount = 0;
    for (const candidate of candidates) {
      const refs = candidate.references.length;
      const wave = waves[waves.length - 1];
      if (!wave || currentCount + refs > budget) {
        waves.push([candidate]);
        currentCount = refs;
      } else {
        wave.push(candidate);
        currentCount += refs;
      }
    }
    return waves;
  };

/** Reduce a candidate's per-reference outcomes to a single outcome, worst
 * first: any errored reference errors the candidate, any failed reference
 * fails it, any pending reference keeps it pending, otherwise it is refunded. */
export const combineRefundOutcomes = (
  outcomes: RefundOutcome[],
): RefundOutcome => {
  if (outcomes.includes("errored")) return "errored";
  if (outcomes.includes("failed")) return "failed";
  if (outcomes.includes("pending")) return "pending";
  return "refunded";
};
