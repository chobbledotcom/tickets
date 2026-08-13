import type {
  RefundReadinessRead,
  RefundReadinessResult,
} from "./readiness.ts";

const UNRESOLVED_EVIDENCE_REASON = {
  multiple_validating_providers:
    "More than one configured payment provider recognizes this payment. Choose its provider before retrying.",
  no_validating_provider:
    "No configured payment provider recognizes this payment. Add the provider it was taken with, or refund it from that provider's dashboard.",
  provider_search_incomplete:
    "A configured payment provider could not answer. Try this refund again before choosing the payment's provider.",
} as const satisfies Record<
  Extract<RefundReadinessRead["evidence"], { status: "unresolved" }>["reason"],
  string
>;

const TAGGED_EVIDENCE_REASON = {
  invalid: "returned invalid payment data",
  missing: "does not recognize the payment",
  unavailable: "could not answer",
} as const satisfies Record<
  Exclude<RefundReadinessRead["evidence"], { status: "unresolved" }>["status"],
  string
>;

const evidenceFailureReason = ({ evidence }: RefundReadinessRead): string => {
  if (evidence.status === "unresolved") {
    return UNRESOLVED_EVIDENCE_REASON[evidence.reason];
  }
  const detail = "reason" in evidence ? ` (${evidence.reason})` : "";
  return `Payment ${evidence.reference} at ${evidence.provider} ${
    TAGGED_EVIDENCE_REASON[evidence.status]
  }${detail}.`;
};

const READINESS_FAILURE_REASON = {
  claim_changed:
    "the payment rows changed while their providers were being recorded",
} as const satisfies Record<
  Exclude<
    Extract<RefundReadinessResult, { kind: "not_ready" }>,
    { reason: "provider_evidence" }
  >["reason"],
  string
>;

/** Explain why no provider or ledger work may start. */
export const refundReadinessMessage = (
  readiness: Extract<RefundReadinessResult, { kind: "not_ready" }>,
): string =>
  readiness.reason === "provider_evidence"
    ? readiness.reads.map(evidenceFailureReason).join(" ")
    : READINESS_FAILURE_REASON[readiness.reason];
