import type { RefundReadinessRead } from "./readiness.ts";

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
