import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { PaymentReviewReason } from "#shared/payment/review.ts";
import {
  chargeMoney,
  chargeMoneyWith,
  fullyRefundedMoney,
  gbp,
  refundObservation,
} from "#test-utils/payment-state.ts";
import { refundLedgerResult } from "#test-utils/refund-ledger.ts";
import {
  expectObligationReview,
  pendingRefundMoney,
  refresh,
  reviewChange,
  runHarness,
} from "./helpers.ts";

describe("refresh payment under an attendee claim", () => {
  test("parks an unsafe returned obligation even while its sibling remains", async () => {
    const run = runHarness({
      ledger: (references) => refundLedgerResult([], references, references),
      observed: fullyRefundedMoney(),
      siblingObserved: chargeMoney(),
    });

    expect(await refresh(run)).toEqual({
      kind: "needs_review",
      message:
        "This payment needs an owner review before another refund can be attempted.",
    });
    expect(run.recorded).toEqual([[run.reference]]);
    expectObligationReview(run);
    expect(run.claim.released).toEqual([
      run.references.flatMap(({ rowSessionIds }) => rowSessionIds),
    ]);
  });

  test("persists an unsafe return while an in-flight sibling keeps the claim", async () => {
    const run = runHarness({
      ledger: (references) => refundLedgerResult([], references, references),
      observed: fullyRefundedMoney(),
      siblingObserved: pendingRefundMoney(),
    });

    expect(await refresh(run)).toEqual({
      kind: "blocked",
      reason: "refund_in_progress",
    });
    expectObligationReview(run);
    expect(run.claim.released).toEqual([[]]);
  });

  test("parks a partial provider refund on its exact rows for owner review", async () => {
    const run = runHarness({
      observed: chargeMoneyWith({
        refunds: [refundObservation({ amount: gbp(40), status: "completed" })],
      }),
    });

    expect(await refresh(run)).toEqual({
      kind: "needs_review",
      message:
        "This payment needs an owner review before another refund can be attempted.",
    });
    expect(run.claim.reviewChanges).toEqual([
      reviewChange(run, {
        kind: "review",
        reason: { kind: "partial_refund" },
      }),
    ]);
    expect(run.claim.released).toEqual([run.reference.rowSessionIds]);
  });

  test("still requires review when clean provider evidence cannot retire the held case", async () => {
    const run = runHarness({
      existingReview: { kind: "partial_refund" },
      observed: chargeMoney(),
    });

    expect(await refresh(run)).toEqual({
      kind: "needs_review",
      message:
        "This payment needs an owner review before another refund can be attempted.",
    });
    expect(run.claim.reviewChanges).toEqual([new Map()]);
    expect(run.claim.released).toEqual([run.reference.rowSessionIds]);
  });

  test("a completed refresh retires reviews disproved by exact evidence", async () => {
    const completedReviewReasons = [
      { kind: "partial_refund" },
      { kind: "partially_returned_obligation" },
      { kind: "uncertain_keyless_refund" },
    ] as const satisfies readonly PaymentReviewReason[];
    for (const existingReview of completedReviewReasons) {
      const completed = runHarness({
        existingReview,
        observed: fullyRefundedMoney(),
      });
      expect(await refresh(completed)).toMatchObject({
        kind: "returned",
        posted: true,
      });
      expect(completed.claim.reviewChanges).toEqual([
        reviewChange(completed, {
          kind: "resolved",
          reason: existingReview.kind,
        }),
      ]);
    }

    const unrelated = runHarness({
      existingReview: { kind: "shared_reference" },
      observed: fullyRefundedMoney(),
    });
    expect(await refresh(unrelated)).toMatchObject({
      kind: "returned",
      posted: true,
    });
    expect(unrelated.claim.reviewChanges).toEqual([
      reviewChange(unrelated, {
        kind: "resolved",
        reason: "shared_reference",
      }),
    ]);
  });

  test("a recorded return retires its review while a sibling remains", async () => {
    const run = runHarness({
      existingReview: { kind: "partial_refund" },
      ledger: (references) => refundLedgerResult(references),
      observed: fullyRefundedMoney(),
      siblingObserved: chargeMoney(),
    });

    expect(await refresh(run)).toEqual({ kind: "current" });
    expect(run.claim.reviewChanges).toEqual([
      reviewChange(run, {
        kind: "resolved",
        reason: "partial_refund",
      }),
    ]);
  });
});
