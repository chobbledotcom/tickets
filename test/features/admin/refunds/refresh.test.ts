import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { RowClaim } from "#routes/admin/refunds/claim.ts";
import type {
  ReadyRefundProvider,
  RefundReadinessResult,
} from "#routes/admin/refunds/readiness.ts";
import {
  refreshClaimedPayment,
  type RefreshPaymentDependencies,
} from "#routes/admin/refunds/refresh.ts";
import type { PaymentReviewChange } from "#shared/db/payment-claim.ts";
import type { RefundPaymentReference } from "#shared/db/payment-references.ts";
import type { ChargeMoney } from "#shared/payment/resources.ts";
import type { PaymentReviewReason } from "#shared/payment/review.ts";
import type { ResolvedRefundCapability } from "#shared/payment/row-state.ts";
import type { RefundLedgerResult } from "#shared/refund-ledger/result.ts";
import {
  candidate,
  tagged,
} from "#test/features/admin/refunds/readiness/helpers.ts";
import {
  chargeMoney,
  chargeMoneyWith,
  fullyRefundedMoney,
  gbp,
  refundObservation,
} from "#test-utils/payment-state.ts";
import { refundLedgerResult } from "#test-utils/refund-ledger.ts";
import { grantingRowClaim } from "#test-utils/refund-routes.ts";

const LISTING_ID = 17;
const ATTENDEE_ID = 23;

const recordingProvider = (): ReadyRefundProvider & { sends: number } => {
  const source: ReadyRefundProvider & { sends: number } = {
    refundCapability: "keyed",
    refundCharge: () => {
      source.sends++;
      return Promise.resolve({ kind: "not_sent", reason: "not_configured" });
    },
    sends: 0,
    type: "stripe",
  };
  return source;
};

const readyResult = (
  observations: readonly {
    observed: ChargeMoney | null;
    reference: Extract<RefundPaymentReference, { kind: "tagged" }>;
  }[],
  provider: ReadyRefundProvider,
): Extract<RefundReadinessResult, { kind: "ready" }> => ({
  candidates: [
    {
      attendee: candidate(ATTENDEE_ID, []).attendee,
      references: observations.map(({ observed, reference }) =>
        observed === null
          ? { kind: "already_returned", provider, reference }
          : { charge: observed, kind: "observed", provider, reference }
      ),
    },
  ],
  capability: "keyed",
  kind: "ready",
});

type HarnessValues = {
  confirmation?: "current" | "new";
  confirmationError?: Error;
  existingUnrecorded?: readonly string[];
  existingReview?: PaymentReviewReason;
  inherited?: ResolvedRefundCapability;
  ledger?: (
    references: readonly RefundPaymentReference[],
  ) => RefundLedgerResult;
  observed?: ChargeMoney | null;
  paymentOnly?: boolean;
  posted?: boolean;
  readiness?: Extract<RefundReadinessResult, { kind: "not_ready" }>;
  siblingObserved?: ChargeMoney | null;
};

const runHarness = (values: HarnessValues = {}) => {
  const reference = tagged("pi_refresh", "stripe");
  const observations: {
    observed: ChargeMoney | null;
    reference: Extract<RefundPaymentReference, { kind: "tagged" }>;
  }[] = [
    {
      observed: values.observed === undefined ? chargeMoney() : values.observed,
      reference,
    },
    ...(values.siblingObserved === undefined ? [] : [
      {
        observed: values.siblingObserved,
        reference: tagged("pi_refresh_sibling", "stripe"),
      },
    ]),
  ];
  const references = observations.map(({ reference }) => reference);
  const source = candidate(ATTENDEE_ID, references);
  const provider = recordingProvider();
  const inherited = values.inherited === undefined
    ? new Map<number, ResolvedRefundCapability>()
    : new Map([[ATTENDEE_ID, values.inherited]]);
  const existingReviews = new Map<string, PaymentReviewReason>();
  if (values.existingReview !== undefined) {
    const [sessionId] = reference.rowSessionIds;
    if (sessionId === undefined) {
      throw new Error("The test reference has no row");
    }
    existingReviews.set(sessionId, values.existingReview);
  }
  const claim = grantingRowClaim(
    new Map([
      [ATTENDEE_ID, references.flatMap(({ rowSessionIds }) => rowSessionIds)],
    ]),
    inherited,
    values.existingUnrecorded === undefined
      ? new Map()
      : new Map([[ATTENDEE_ID, values.existingUnrecorded]]),
    existingReviews,
  );
  const marked: (readonly RefundPaymentReference[])[] = [];
  const recorded: (readonly RefundPaymentReference[])[] = [];
  const calls = { confirm: 0, paymentOnly: 0, prepare: 0, record: 0 };
  const dependencies: RefreshPaymentDependencies = {
    claim,
    confirm: () => {
      calls.confirm++;
      expect(claim.released).toEqual([]);
      return values.confirmationError === undefined
        ? Promise.resolve(values.confirmation ?? "new")
        : Promise.reject(values.confirmationError);
    },
    markReturned: (references) => {
      marked.push(references);
      return Promise.resolve();
    },
    paymentOnly: () => {
      calls.paymentOnly++;
      return Promise.resolve(values.paymentOnly ?? true);
    },
    prepare: () => {
      calls.prepare++;
      return Promise.resolve(
        values.readiness ?? readyResult(observations, provider),
      );
    },
    record: (_attendeeId, references) => {
      calls.record++;
      recorded.push(references);
      return Promise.resolve(
        values.ledger?.(references) ??
          ((values.posted ?? true)
            ? refundLedgerResult(references)
            : refundLedgerResult([], references)),
      );
    },
  };
  return {
    calls,
    claim,
    dependencies,
    marked,
    provider,
    recorded,
    reference,
    references,
    source,
  };
};

type RefreshHarness = ReturnType<typeof runHarness>;

const refresh = (
  run: RefreshHarness,
  dependencies: RefreshPaymentDependencies = run.dependencies,
) => refreshClaimedPayment(run.source, LISTING_ID, dependencies);

const firstReferenceRow = (run: RefreshHarness): string => {
  const [sessionId] = run.reference.rowSessionIds;
  if (sessionId === undefined) throw new Error("The test reference has no row");
  return sessionId;
};

const reviewChange = (
  run: RefreshHarness,
  change: PaymentReviewChange,
): ReadonlyMap<string, PaymentReviewChange> =>
  new Map([[firstReferenceRow(run), change]]);

const pendingRefundMoney = (): ChargeMoney =>
  chargeMoneyWith({
    refunds: [refundObservation({ amount: gbp(100), status: "pending" })],
  });

const expectNewCompletedRefresh = async (
  run: RefreshHarness,
): Promise<void> => {
  expect(await refresh(run)).toEqual({
    confirmation: "new",
    kind: "returned",
    posted: true,
  });
  expect(run.provider.sends).toBe(0);
  expect(run.marked).toEqual([[run.reference]]);
};

const expectObligationReview = (run: RefreshHarness): void => {
  expect(run.claim.unrecorded).toEqual([run.reference.rowSessionIds]);
  expect(run.claim.reviewChanges).toEqual([
    reviewChange(run, {
      kind: "review",
      reason: { kind: "partially_returned_obligation" },
    }),
  ]);
};

describe("refresh payment under an attendee claim", () => {
  test("records exact returned evidence without asking the provider to send", async () => {
    const run = runHarness({ observed: fullyRefundedMoney() });

    await expectNewCompletedRefresh(run);
    expect(run.recorded).toEqual([[run.reference]]);
    expect(run.claim.released).toEqual([run.reference.rowSessionIds]);
  });

  test("marks the exact returned rows while releasing a missed ledger post", async () => {
    const run = runHarness({ observed: fullyRefundedMoney(), posted: false });

    expect(
      await refresh(run),
    ).toEqual({ kind: "returned", posted: false });
    expect(run.calls.confirm).toBe(0);
    expect(run.claim.released).toEqual([run.reference.rowSessionIds]);
    expect(run.claim.unrecorded).toEqual([run.reference.rowSessionIds]);
  });

  test("reuses a completed marker without a provider read or send", async () => {
    const run = runHarness({ observed: null, paymentOnly: false });

    await expectNewCompletedRefresh(run);
    expect(run.calls.confirm).toBe(1);
  });

  test("keeps the claim when operator-visible confirmation fails", async () => {
    const run = runHarness({
      confirmationError: new Error("activity unavailable"),
      observed: fullyRefundedMoney(),
    });

    await expect(
      refresh(run),
    ).rejects.toThrow("activity unavailable");
    expect(run.calls.confirm).toBe(1);
    expect(run.claim.released).toEqual([]);
  });

  test("releases a keyed claim when fresh evidence says nothing returned", async () => {
    const run = runHarness({ inherited: "keyed" });

    expect(
      await refresh(run),
    ).toEqual({ kind: "current" });
    expect(run.marked).toEqual([[]]);
    expect(run.calls.record).toBe(0);
    expect(run.claim.released).toEqual([run.reference.rowSessionIds]);
  });

  test("records a returned reference while its independent sibling remains", async () => {
    const run = runHarness({
      observed: fullyRefundedMoney(),
      siblingObserved: chargeMoney(),
    });

    expect(
      await refresh(run),
    ).toEqual({ kind: "current" });
    expect(run.recorded).toEqual([[run.reference]]);
    expect(run.claim.recorded).toEqual([run.reference.rowSessionIds]);
    expect(run.claim.released).toEqual([
      run.references.flatMap(({ rowSessionIds }) => rowSessionIds),
    ]);
    expect(run.calls.confirm).toBe(0);
    expect(run.calls.paymentOnly).toBe(0);
  });

  test("parks an unsafe returned obligation even while its sibling remains", async () => {
    const run = runHarness({
      ledger: (references) => refundLedgerResult([], references, references),
      observed: fullyRefundedMoney(),
      siblingObserved: chargeMoney(),
    });

    expect(
      await refresh(run),
    ).toEqual({
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

    expect(
      await refresh(run),
    ).toEqual({ kind: "blocked", reason: "refund_in_progress" });
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

  test("a completed refresh retires only its earlier partial-refund review", async () => {
    const completedReviewReasons = [
      { kind: "partial_refund" },
      { kind: "partially_returned_obligation" },
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
    expect(unrelated.claim.reviewChanges).toEqual([new Map()]);
  });

  test("retains an inherited keyless claim when no refund is visible", async () => {
    const run = runHarness({ inherited: "keyless" });

    expect(await refresh(run)).toEqual({
      kind: "blocked",
      reason: "refund_in_progress",
    });
    expect(run.provider.sends).toBe(0);
    expect(run.claim.released).toEqual([]);
  });

  test("retains the claim while an observed refund is still settling", async () => {
    const run = runHarness({
      observed: pendingRefundMoney(),
    });

    expect(await refresh(run)).toEqual({
      kind: "blocked",
      reason: "refund_in_progress",
    });
    expect(run.claim.released).toEqual([]);
  });

  test("reports readiness evidence and releases a fresh unread claim", async () => {
    const run = runHarness({
      readiness: {
        kind: "not_ready",
        reads: [
          {
            evidence: {
              attempts: [],
              reason: "no_validating_provider",
              reference: "pi_refresh",
              source: "untagged",
              status: "unresolved",
            },
            index: "old_pi_refresh",
          },
        ],
        reason: "provider_evidence",
      },
    });

    expect(
      await refresh(run),
    ).toEqual({
      kind: "not_ready",
      message:
        "No configured payment provider recognizes this payment. Add the provider it was taken with, or refund it from that provider's dashboard.",
    });
    expect(run.marked).toEqual([]);
    expect(run.claim.released).toEqual([run.reference.rowSessionIds]);
  });

  test("does not erase an existing unrecorded mark when readiness fails", async () => {
    const run = runHarness({
      existingUnrecorded: ["sess-missed"],
      readiness: {
        indexes: ["old_pi_refresh"],
        kind: "not_ready",
        reason: "historical_marker",
      },
    });

    expect(
      await refresh(run),
    ).toMatchObject({ kind: "not_ready" });
    expect(run.claim.unrecorded).toEqual([[]]);
  });

  test("retains an inherited claim when provider evidence cannot answer", async () => {
    const run = runHarness({
      inherited: "keyed",
      readiness: { kind: "not_ready", reason: "claim_changed" },
    });

    expect(
      await refresh(run),
    ).toEqual({
      kind: "not_ready",
      message:
        "the payment rows changed while their providers were being recorded",
    });
    expect(run.claim.released).toEqual([]);
  });

  const refusingClaim = (
    result: Awaited<ReturnType<RowClaim["claim"]>>,
  ): RowClaim => ({
    claim: () => Promise.resolve(result),
    settle: () => Promise.reject(new Error("nothing was claimed")),
  });

  test("does not prepare after another live refund owns the claim", async () => {
    const run = runHarness();
    const claim = refusingClaim({
      blockedBy: { kind: "held" },
      kind: "blocked",
    });

    expect(
      await refresh(run, {
        ...run.dependencies,
        claim,
      }),
    ).toEqual({ kind: "blocked", reason: "refund_in_progress" });
    expect(run.calls.prepare).toBe(0);
  });

  test("does not prepare after the loaded payment set changes", async () => {
    const run = runHarness();
    const claim = refusingClaim({ kind: "changed" });

    expect(
      await refresh(run, {
        ...run.dependencies,
        claim,
      }),
    ).toEqual({
      kind: "not_ready",
      message:
        "The attendee or payment set changed while this refresh was starting. Try again.",
    });
    expect(run.calls.prepare).toBe(0);
  });
});
