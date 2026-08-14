import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { RefundReadinessRead } from "#routes/admin/refunds/readiness.ts";
import { refundReadinessMessage } from "#routes/admin/refunds/readiness-problem.ts";

const messageForEvidence = (
  evidence: RefundReadinessRead["evidence"],
): string =>
  refundReadinessMessage({
    reads: [{ evidence, index: "stored_index" }],
  });

describe("refund readiness messages", () => {
  for (
    const [name, evidence, message] of [
      [
        "a tagged provider does not recognize its reference",
        {
          provider: "stripe",
          reference: "pi_tagged",
          status: "missing",
        },
        "Payment pi_tagged at stripe does not recognize the payment.",
      ],
      [
        "a tagged provider returns invalid data",
        {
          provider: "square",
          reason: "mismatched_id",
          reference: "square_tagged",
          status: "invalid",
        },
        "Payment square_tagged at square returned invalid payment data (mismatched_id).",
      ],
      [
        "a tagged provider cannot answer",
        {
          provider: "sumup",
          reason: "timeout",
          reference: "sumup_tagged",
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
});
