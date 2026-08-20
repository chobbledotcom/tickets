import type { RefundReferenceProblem } from "#db/payment-references.ts";
import { t } from "#i18n";
import type { RefundReadinessRead } from "./readiness.ts";

const REFERENCE_PROBLEM_MESSAGE = {
  legacy_unindexed: "error.payment_history_incomplete",
  provider_unknown: "error.payment_provider_unknown",
  too_many_references: "error.payment_history_too_large",
} as const satisfies Record<RefundReferenceProblem["kind"], string>;

/** Explain why provider-tagged payment history could not be loaded safely. */
export const refundReferenceProblemMessage = (
  problem: RefundReferenceProblem,
): string => t(REFERENCE_PROBLEM_MESSAGE[problem.kind]);

const TAGGED_EVIDENCE_REASON = {
  invalid: "returned invalid payment data",
  missing: "does not recognize the payment",
  unavailable: "could not answer",
} as const satisfies Record<RefundReadinessRead["evidence"]["status"], string>;

const evidenceFailureReason = ({ evidence }: RefundReadinessRead): string => {
  const detail = "reason" in evidence ? ` (${evidence.reason})` : "";
  return `Payment ${evidence.reference} at ${evidence.provider} ${
    TAGGED_EVIDENCE_REASON[evidence.status]
  }${detail}.`;
};

/** Explain why complete provider evidence could not be established. */
export const refundReadinessMessage = (readiness: {
  readonly reads: readonly RefundReadinessRead[];
}): string => readiness.reads.map(evidenceFailureReason).join(" ");
