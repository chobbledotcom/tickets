import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { RunFindings } from "#routes/admin/refunds/claim.ts";
import {
  currentPaymentReviews,
  type ProviderReviewFinding,
  reconcileProviderReviewFindings,
} from "#routes/admin/refunds/provider-reviews.ts";
import type { PaymentReviewReason } from "#shared/payment/review.ts";
import { tagged } from "#test/features/admin/refunds/readiness/helpers.ts";

const OBSERVED_ROW = "session_observed";
const UNOBSERVED_ROW = "session_unobserved";

const observedReference = tagged("pi_observed", "stripe", "observed");

const emptyFindings = (): RunFindings => ({
  claimPhases: new Map(),
  doubts: new Map(),
  recorded: new Set(),
  reviews: new Map(),
  unrecorded: new Map(),
});

const providerReview = (
  reason: PaymentReviewReason,
  reference = observedReference,
): ProviderReviewFinding => ({ reason, reference });

describe("admin refunds > provider review findings", () => {
  test("clean complete evidence retires disproved provider issues on only observed rows", () => {
    const disprovedReasons = [
      { kind: "multiple_pending_refunds" },
      { kind: "refund_exceeds_capture" },
    ] as const satisfies readonly PaymentReviewReason[];

    for (const reason of disprovedReasons) {
      const findings = emptyFindings();
      const heldReviews = new Map<string, PaymentReviewReason>([
        [OBSERVED_ROW, reason],
        [UNOBSERVED_ROW, reason],
      ]);

      reconcileProviderReviewFindings(
        findings,
        heldReviews,
        [observedReference],
        [],
      );
      expect(currentPaymentReviews(heldReviews, findings)).toEqual(
        new Map([[UNOBSERVED_ROW, reason]]),
      );
      expect(findings.reviews).toEqual(
        new Map([[OBSERVED_ROW, { kind: "resolved", reason: reason.kind }]]),
      );
    }
  });

  test("a current different provider issue wins over retirement", () => {
    const findings = emptyFindings();
    const currentReason = { kind: "partial_refund" } as const;

    const heldReviews = new Map([
      [OBSERVED_ROW, { kind: "multiple_pending_refunds" } as const],
    ]);
    reconcileProviderReviewFindings(
      findings,
      heldReviews,
      [observedReference],
      [providerReview(currentReason)],
    );
    expect(currentPaymentReviews(heldReviews, findings)).toEqual(
      new Map([[OBSERVED_ROW, currentReason]]),
    );
    expect(findings.reviews).toEqual(
      new Map([[OBSERVED_ROW, { kind: "review", reason: currentReason }]]),
    );
  });

  test("clean provider evidence preserves issues it cannot disprove", () => {
    const preservedReasons = [
      { kind: "partial_refund" },
      { kind: "partially_returned_obligation" },
      { kind: "shared_reference" },
      { kind: "uncertain_keyless_refund" },
    ] as const satisfies readonly PaymentReviewReason[];

    for (const reason of preservedReasons) {
      const findings = emptyFindings();
      const heldReviews = new Map([[OBSERVED_ROW, reason]]);

      reconcileProviderReviewFindings(
        findings,
        heldReviews,
        [observedReference],
        [],
      );
      expect(currentPaymentReviews(heldReviews, findings)).toEqual(heldReviews);
      expect(findings.reviews).toEqual(new Map());
    }
  });

  test("writes every current finding onto the rows that supplied it", () => {
    const findings = emptyFindings();
    const siblingReference = tagged("pi_sibling", "stripe", "sibling");

    reconcileProviderReviewFindings(
      findings,
      new Map(),
      [observedReference, siblingReference],
      [
        providerReview({ kind: "partial_refund" }),
        providerReview({ kind: "refund_exceeds_capture" }, siblingReference),
      ],
    );
    expect(currentPaymentReviews(new Map(), findings)).toEqual(
      new Map([
        [OBSERVED_ROW, { kind: "partial_refund" }],
        ["session_sibling", { kind: "refund_exceeds_capture" }],
      ]),
    );
    expect(findings.reviews).toEqual(
      new Map([
        [OBSERVED_ROW, { kind: "review", reason: { kind: "partial_refund" } }],
        [
          "session_sibling",
          {
            kind: "review",
            reason: { kind: "refund_exceeds_capture" },
          },
        ],
      ]),
    );
  });
});
