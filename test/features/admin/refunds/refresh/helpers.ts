import { expect } from "@std/expect";
import type { RefundCandidate } from "#routes/admin/refunds/candidates.ts";
import type {
  ReadyRefundProvider,
  RefundReadinessResult,
} from "#routes/admin/refunds/readiness.ts";
import {
  type RefreshPaymentDependencies,
  type RefreshPaymentResult,
  refreshClaimedPayment,
} from "#routes/admin/refunds/refresh.ts";
import type { RefundPaymentReference } from "#shared/db/payment-references.ts";
import type { ChargeMoney } from "#shared/payment/resources.ts";
import type { PaymentReviewReason } from "#shared/payment/review.ts";
import type { PaymentReviewChange } from "#shared/payment/row-transitions.ts";
import {
  type ProviderRefundTarget,
  type RefundAuthorityReceipt,
  requestProviderRefund,
} from "#shared/provider-refunds.ts";
import type { RefundLedgerResult } from "#shared/refund-ledger/result.ts";
import {
  type RecordingProvider,
  provider as recordingProvider,
} from "#test/features/admin/refunds/provider/helpers.ts";
import {
  candidate,
  tagged,
} from "#test/features/admin/refunds/readiness/helpers.ts";
import {
  chargeMoney,
  chargeMoneyWith,
  gbp,
  refundObservation,
} from "#test-utils/payment-state.ts";
import { refundLedgerResult } from "#test-utils/refund-ledger.ts";
import { grantingRowClaim } from "#test-utils/refund-routes.ts";

const LISTING_ID = 17;
const ATTENDEE_ID = 23;
const REFERENCE_INDEX = "refresh";
const REFERENCE_ROW_ID = `session_${REFERENCE_INDEX}`;

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
          : { charge: observed, kind: "observed", provider, reference },
      ),
    },
  ],
  kind: "ready",
});

type HarnessValues = {
  confirmation?: "current" | "new";
  confirmationError?: Error;
  existingReview?: PaymentReviewReason;
  ledger?: (
    references: readonly RefundPaymentReference[],
  ) => RefundLedgerResult;
  observed?: ChargeMoney | null;
  paymentOnly?: boolean;
  posted?: boolean;
  readiness?: Extract<RefundReadinessResult, { kind: "not_ready" }>;
  siblingObserved?: ChargeMoney | null;
};

type TaggedReference = Extract<RefundPaymentReference, { kind: "tagged" }>;

export interface RefreshHarness {
  readonly authorities: (readonly RefundAuthorityReceipt[])[];
  readonly calls: {
    confirm: number;
    paymentOnly: number;
    prepare: number;
    record: number;
    recordAuthorities: number;
  };
  readonly claim: ReturnType<typeof grantingRowClaim>;
  readonly dependencies: RefreshPaymentDependencies;
  readonly observed: ProviderRefundTarget[];
  readonly provider: RecordingProvider;
  readonly ready: Extract<RefundReadinessResult, { kind: "ready" }>;
  readonly recorded: (readonly RefundPaymentReference[])[];
  readonly reference: TaggedReference;
  readonly references: TaggedReference[];
  readonly rowSessionId: string;
  readonly source: RefundCandidate;
}

export const runHarness = (values: HarnessValues = {}): RefreshHarness => {
  const reference = tagged("pi_refresh", "stripe", REFERENCE_INDEX);
  const observations: {
    observed: ChargeMoney | null;
    reference: Extract<RefundPaymentReference, { kind: "tagged" }>;
  }[] = [
    {
      observed: values.observed === undefined ? chargeMoney() : values.observed,
      reference,
    },
    ...(values.siblingObserved === undefined
      ? []
      : [
          {
            observed: values.siblingObserved,
            reference: tagged("pi_refresh_sibling", "stripe"),
          },
        ]),
  ];
  const references = observations.map(({ reference }) => reference);
  const source = candidate(ATTENDEE_ID, references);
  const provider = recordingProvider();
  const ready = readyResult(observations, provider);
  const existingReviews = new Map<string, PaymentReviewReason>();
  if (values.existingReview !== undefined) {
    existingReviews.set(REFERENCE_ROW_ID, values.existingReview);
  }
  const claim = grantingRowClaim(
    new Map([
      [ATTENDEE_ID, references.flatMap(({ rowSessionIds }) => rowSessionIds)],
    ]),
    new Map(),
    existingReviews,
  );
  const authorities: (readonly RefundAuthorityReceipt[])[] = [];
  const observed: ProviderRefundTarget[] = [];
  const recorded: (readonly RefundPaymentReference[])[] = [];
  const calls = {
    confirm: 0,
    paymentOnly: 0,
    prepare: 0,
    record: 0,
    recordAuthorities: 0,
  };
  const dependencies: RefreshPaymentDependencies = {
    claim,
    confirm: () => {
      calls.confirm++;
      expect(claim.released).toEqual([]);
      return values.confirmationError === undefined
        ? Promise.resolve(values.confirmation ?? "new")
        : Promise.reject(values.confirmationError);
    },
    paymentOnly: () => {
      calls.paymentOnly++;
      return Promise.resolve(values.paymentOnly ?? true);
    },
    prepare: () => {
      calls.prepare++;
      return Promise.resolve(values.readiness ?? ready);
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
    recordAuthorities: (receipts) => {
      calls.recordAuthorities++;
      authorities.push(receipts);
      return Promise.resolve();
    },
    request: (target, dependencies) => {
      observed.push(target);
      return requestProviderRefund(target, dependencies);
    },
  };
  return {
    authorities,
    calls,
    claim,
    dependencies,
    observed,
    provider,
    ready,
    recorded,
    reference,
    references,
    rowSessionId: REFERENCE_ROW_ID,
    source,
  };
};

export const refresh = (
  run: RefreshHarness,
  dependencies: RefreshPaymentDependencies = run.dependencies,
): Promise<RefreshPaymentResult> =>
  refreshClaimedPayment(run.source, LISTING_ID, dependencies);

export const reviewChange = (
  run: RefreshHarness,
  change: PaymentReviewChange,
): ReadonlyMap<string, PaymentReviewChange> =>
  new Map([[run.rowSessionId, change]]);

export const pendingRefundMoney = (): ChargeMoney =>
  chargeMoneyWith({
    refunds: [refundObservation({ amount: gbp(100), status: "pending" })],
  });

export const expectNewCompletedRefresh = async (
  run: RefreshHarness,
): Promise<void> => {
  expect(await refresh(run)).toEqual({
    confirmation: "new",
    kind: "returned",
    posted: true,
  });
  expect(run.provider.refunds).toEqual([]);
  expect(run.observed).toEqual([
    expect.objectContaining({ mode: "observe_only", reference: run.reference }),
  ]);
};

export const expectObligationReview = (run: RefreshHarness): void => {
  expect(run.claim.unrecorded).toEqual([run.reference.rowSessionIds]);
  expect(run.claim.reviewChanges).toEqual([
    reviewChange(run, {
      kind: "review",
      reason: { kind: "partially_returned_obligation" },
    }),
  ]);
};
