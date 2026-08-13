import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type {
  RefundReadinessRead,
  RefundReadinessResult,
} from "#routes/admin/refunds/readiness.ts";
import { refundReadinessMessage } from "#routes/admin/refunds/readiness-problem.ts";

const messageForEvidence = (
  evidence: RefundReadinessRead["evidence"],
): string =>
  refundReadinessMessage({
    kind: "not_ready",
    observations: [],
    reads: [{ evidence, index: "stored_index" }],
    reason: "provider_evidence",
  });

describe("refund readiness messages", () => {
  for (
    const [name, evidence, message] of [
      [
        "no provider recognizes an old reference",
        {
          attempts: [],
          reason: "no_validating_provider",
          reference: "pi_old",
          source: "untagged",
          status: "unresolved",
        },
        "No configured payment provider recognizes this payment. Add the provider it was taken with, or refund it from that provider's dashboard.",
      ],
      [
        "multiple providers recognize an old reference",
        {
          attempts: [],
          reason: "multiple_validating_providers",
          reference: "pi_old",
          source: "untagged",
          status: "unresolved",
        },
        "More than one configured payment provider recognizes this payment. Choose its provider before retrying.",
      ],
      [
        "a provider search cannot finish",
        {
          attempts: [
            {
              provider: "stripe",
              result: { reason: "timeout", status: "unavailable" },
            },
          ],
          reason: "provider_search_incomplete",
          reference: "pi_old",
          source: "untagged",
          status: "unresolved",
        },
        "A configured payment provider could not answer. Try this refund again before choosing the payment's provider.",
      ],
      [
        "a tagged provider does not recognize its reference",
        {
          attempts: [],
          provider: "stripe",
          reference: "pi_tagged",
          source: "tagged",
          status: "missing",
        },
        "Payment pi_tagged at stripe does not recognize the payment.",
      ],
      [
        "a tagged provider returns invalid data",
        {
          attempts: [],
          provider: "square",
          reason: "mismatched_id",
          reference: "square_tagged",
          source: "tagged",
          status: "invalid",
        },
        "Payment square_tagged at square returned invalid payment data (mismatched_id).",
      ],
      [
        "a tagged provider cannot answer",
        {
          attempts: [],
          provider: "sumup",
          reason: "timeout",
          reference: "sumup_tagged",
          source: "tagged",
          status: "unavailable",
        },
        "Payment sumup_tagged at sumup could not answer (timeout).",
      ],
    ] satisfies ReadonlyArray<
      readonly [string, RefundReadinessRead["evidence"], string]
    >
  ) {
    test(name, () => expect(messageForEvidence(evidence)).toBe(message));
  }

  test("a changed claim names the provider-binding race", () => {
    const readiness = {
      kind: "not_ready",
      observations: [],
      reason: "claim_changed",
    } satisfies Extract<RefundReadinessResult, { kind: "not_ready" }>;
    expect(refundReadinessMessage(readiness)).toBe(
      "the payment rows changed while their providers were being recorded",
    );
  });
});
