import type { RefundCandidate } from "./candidates.ts";

/** The result of attempting to refund one charge reference (or a whole
 * candidate, once its per-reference outcomes are combined). */
export type RefundOutcome = "refunded" | "failed" | "errored";

/** Take the leading candidates whose combined charge count fits this request.
 * Every later candidate is already queued before this selection runs. */
export const takeRefundWave =
  (budget: number) =>
  (candidates: RefundCandidate[]): RefundCandidate[] => {
    const wave: RefundCandidate[] = [];
    let used = 0;
    for (const candidate of candidates) {
      const refs = candidate.references.length;
      if (used + refs > budget) break;
      wave.push(candidate);
      used += refs;
    }
    return wave;
  };
