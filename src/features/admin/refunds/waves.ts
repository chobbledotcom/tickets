/** What a refund came to. `withheld` means no money was sent and the reason has
 * already been reported at the volume it deserved. `pending` means the
 * provider accepted it but has not yet proved the money returned. */
export type RefundOutcome =
  | "refunded"
  | "pending"
  | "withheld"
  | "failed";

type CandidateWithReferences = {
  readonly references: readonly unknown[];
};

/** Pack candidates into waves whose combined charge references stay within
 * `budget`, so each concurrently-processed wave issues at most ~`budget`
 * provider subrequests. A single candidate carrying more references than the
 * budget forms its own wave; its references are chunked inside the attempt. */
export const packByReferenceCount =
  (budget: number) =>
  <TCandidate extends CandidateWithReferences>(
    candidates: readonly TCandidate[],
  ): TCandidate[][] => {
    const waves: TCandidate[][] = [];
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
const OUTCOMES_WORST_FIRST = [
  "failed",
  "pending",
  "withheld",
] as const;

/** Reduce a candidate's per-reference outcomes to a single outcome. */
export const combineRefundOutcomes = (
  outcomes: RefundOutcome[],
): RefundOutcome =>
  OUTCOMES_WORST_FIRST.find((worst) => outcomes.includes(worst)) ?? "refunded";
