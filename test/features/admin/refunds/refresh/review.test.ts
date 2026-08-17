import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { describeWithEnv } from "#test-utils/db.ts";
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
  type RefreshHarness,
  refresh,
  reviewChange,
  runHarness,
} from "./helpers.ts";

const NEEDS_OWNER_REVIEW = {
  kind: "needs_review",
  message:
    "This payment needs an owner review before another refund can be attempted.",
} as const;

const expectReviewUnchanged = async (run: RefreshHarness): Promise<void> => {
  expect(await refresh(run)).toEqual(NEEDS_OWNER_REVIEW);
  expect(run.claim.reviewChanges).toEqual([new Map()]);
  expect(run.claim.released).toEqual([run.reference.rowSessionIds]);
};

const expectCompletedReviewRetired = async (
  reason: "partially_returned_obligation" | "shared_reference",
): Promise<void> => {
  const run = runHarness({
    existingReview: { kind: reason },
    observed: fullyRefundedMoney(),
  });
  expect(await refresh(run)).toMatchObject({
    kind: "returned",
    posted: true,
  });
  expect(run.claim.reviewChanges).toEqual([
    reviewChange(run, { kind: "resolved", reason }),
  ]);
};

describeWithEnv("refresh payment under an attendee claim", { db: true }, () => {
  test("parks an unsafe returned obligation even while its sibling remains", async () => {
    const run = runHarness({
      ledger: (references) => refundLedgerResult([], references, references),
      observed: fullyRefundedMoney(),
      siblingObserved: chargeMoney(),
    });

    expect(await refresh(run)).toEqual(NEEDS_OWNER_REVIEW);
    expect(run.recorded).toEqual([[run.reference]]);
    expectObligationReview(run);
    expect(run.claim.released).toEqual([
      run.references.flatMap(({ rowSessionIds }) => rowSessionIds),
    ]);
  });

  test("persists an unsafe return while authority observes its sibling", async () => {
    const run = runHarness({
      ledger: (references) => refundLedgerResult([], references, references),
      observed: fullyRefundedMoney(),
      siblingObserved: pendingRefundMoney(),
    });

    expect(await refresh(run)).toEqual(NEEDS_OWNER_REVIEW);
    expectObligationReview(run);
    expect(run.provider.refunds).toEqual([]);
    expect(run.claim.released).toEqual([
      run.references.flatMap(({ rowSessionIds }) => rowSessionIds),
    ]);
  });

  test("gives a partial provider refund only to the canonical authority", async () => {
    const run = runHarness({
      observed: chargeMoneyWith({
        refunds: [refundObservation({ amount: gbp(40), status: "completed" })],
      }),
    });

    await expectReviewUnchanged(run);
  });

  test("still requires review until returned money is recorded", async () => {
    const run = runHarness({
      existingReview: { kind: "partially_returned_obligation" },
      observed: chargeMoney(),
    });

    await expectReviewUnchanged(run);
  });

  test("a completed refresh retires an obligation review", async () => {
    await expectCompletedReviewRetired("partially_returned_obligation");
    await expectCompletedReviewRetired("shared_reference");
  });

  test("a recorded return retires its review while a sibling remains", async () => {
    const run = runHarness({
      existingReview: { kind: "partially_returned_obligation" },
      ledger: (references) => refundLedgerResult(references),
      observed: fullyRefundedMoney(),
      siblingObserved: chargeMoney(),
    });

    expect(await refresh(run)).toEqual({ kind: "current" });
    expect(run.claim.reviewChanges).toEqual([
      reviewChange(run, {
        kind: "resolved",
        reason: "partially_returned_obligation",
      }),
    ]);
  });
});
