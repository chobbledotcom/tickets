import type { RefundCandidate } from "./candidates.ts";

/** What a refund came to. `withheld` means no money was sent and the reason has
 *  already been reported at the volume it deserved — separate from `failed` so
 *  a bulk tally does not report it again as an incident. */
export type RefundOutcome = "refunded" | "withheld" | "failed" | "errored";

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

/** Worst wins, so one bad reference is never hidden by a good one beside it. */
const OUTCOMES_WORST_FIRST = ["errored", "failed", "withheld"] as const;

/** Reduce a candidate's per-reference outcomes to a single outcome. */
export const combineRefundOutcomes = (
  outcomes: RefundOutcome[],
): RefundOutcome =>
  OUTCOMES_WORST_FIRST.find((worst) => outcomes.includes(worst)) ?? "refunded";
