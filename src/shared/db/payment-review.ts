/** Retiring payment work after the owner has made the required decision. */

/* jscpd:ignore-start -- imports */
import { logActivity } from "#shared/db/activity-log.ts";
import { withTransaction } from "#shared/db/client.ts";
import {
  loadAttendeeRowStates,
  type PaymentRowRecord,
  paymentRowStateStatement,
  readAttendeeRowStates,
} from "#shared/db/payment-claim.ts";
import { STALE_RESERVATION_MS } from "#shared/limits.ts";
import { isoBefore } from "#shared/now.ts";
import { claimLeaseMs, isClaimStale } from "#shared/payment/claim.ts";
import type {
  PaymentRowState,
  StoredPaymentFailure,
} from "#shared/payment/row-state.ts";
/* jscpd:ignore-end */

export type ResolvePaymentReviewInput = {
  readonly attendeeId: number;
  readonly listingId: number;
};

export type ResolvePaymentReviewResult =
  | { readonly kind: "claim_in_progress" }
  | { readonly kind: "nothing_to_review" }
  | { readonly kind: "resolved" };

/** The one operator-facing state of an attendee's payment work. */
export type PaymentWorkStatus =
  | "clear"
  | "moving"
  | "needs_money_record"
  | "needs_review";

const OWNER_RESOLVED_OUTCOME: StoredPaymentFailure = {
  error: "Payment review resolved by the owner",
};

const REVIEW_ACTIVITY = "Payment marked reviewed by owner";

type RowReviewDecision =
  | { readonly kind: "blocked" }
  | { readonly kind: "current" }
  | { readonly claim: "none" | "release"; readonly kind: "resolve" };

type JudgedPaymentRow = {
  readonly decision: RowReviewDecision;
  readonly row: PaymentRowRecord;
};

const WORK_BY_DECISION = {
  blocked: "moving",
  current: "clear",
  resolve: "needs_review",
} as const satisfies Record<RowReviewDecision["kind"], PaymentWorkStatus>;

const WORK_PRIORITY = {
  clear: 0,
  moving: 3,
  needs_money_record: 1,
  needs_review: 2,
} as const satisfies Record<PaymentWorkStatus, number>;

const reviewDecision = (
  row: PaymentRowRecord,
  staleBefore: string,
): RowReviewDecision => {
  const claim = row.state.claim;
  if (claim === undefined) {
    return row.state.review === undefined
      ? { kind: "current" }
      : { claim: "none", kind: "resolve" };
  }
  return claim.capability === "unresolved" && isClaimStale(claim, staleBefore)
    ? { claim: "release", kind: "resolve" }
    : { kind: "blocked" };
};

const judgePaymentRows = (
  rows: readonly PaymentRowRecord[],
  staleBefore: string,
): JudgedPaymentRow[] =>
  rows.map((row) => ({ decision: reviewDecision(row, staleBefore), row }));

/** One aggregate state drives both action visibility and POST decisions. */
const rowWorkStatus = ({
  decision,
  row,
}: JudgedPaymentRow): PaymentWorkStatus =>
  decision.kind === "current" && row.state.unrecorded !== undefined
    ? "needs_money_record"
    : WORK_BY_DECISION[decision.kind];

const paymentWorkStatus = (
  judged: readonly JudgedPaymentRow[],
): PaymentWorkStatus =>
  judged.reduce<PaymentWorkStatus>((chosen, row) => {
    const candidate = rowWorkStatus(row);
    return WORK_PRIORITY[candidate] > WORK_PRIORITY[chosen]
      ? candidate
      : chosen;
  }, "clear");

/** Read the one payment-work state that decides which owner action is safe. */
export const getPaymentWorkStatus = async (
  attendeeId: number,
): Promise<PaymentWorkStatus> =>
  paymentWorkStatus(
    judgePaymentRows(
      await loadAttendeeRowStates([attendeeId]),
      isoBefore(claimLeaseMs(STALE_RESERVATION_MS)),
    ),
  );

/** Remove the work the owner resolved while preserving every settled fact. */
const resolvedState = (
  row: PaymentRowRecord,
  claim: "none" | "release",
): PaymentRowState => {
  const { review: _review, ...withoutReview } = row.state;
  if (claim === "none") return withoutReview;
  const { claim: _claim, ...settled } = withoutReview;
  return settled.outcome === undefined
    ? { ...settled, outcome: OWNER_RESOLVED_OUTCOME }
    : settled;
};

const assertEveryRowChanged = (
  rows: readonly PaymentRowRecord[],
  affected: readonly number[],
): void => {
  const missed = rows.find((_, index) => affected[index] !== 1);
  if (missed !== undefined) {
    throw new Error(
      `Payment review no longer owns payment row ${missed.sessionId}`,
    );
  }
};

/**
 * Retire one attendee's owner-review work and its mirrors atomically.
 *
 * A fresh claim may still be moving money. A stale claim is owner-resolvable
 * only while it remains `unresolved`, proving no provider capability was ever
 * bound to it; stale keyed and keyless calls may have sent money and stay put.
 */
export const resolvePaymentReview = (
  input: ResolvePaymentReviewInput,
): Promise<ResolvePaymentReviewResult> => {
  const staleBefore = isoBefore(claimLeaseMs(STALE_RESERVATION_MS));
  return withTransaction(async (tx) => {
    const rows = await readAttendeeRowStates(tx, [input.attendeeId]);
    const judged = judgePaymentRows(rows, staleBefore);
    const status = paymentWorkStatus(judged);
    if (status === "moving") {
      return { kind: "claim_in_progress" };
    }
    const changing = judged.flatMap(({ decision, row }) =>
      decision.kind === "resolve" ? [{ decision, row }] : [],
    );
    if (status !== "needs_review") return { kind: "nothing_to_review" };

    const results = await tx.batch(
      await Promise.all(
        changing.map(({ decision, row }) =>
          paymentRowStateStatement(row, resolvedState(row, decision.claim)),
        ),
      ),
    );
    assertEveryRowChanged(
      changing.map(({ row }) => row),
      results.map((result) => result.rowsAffected),
    );
    await logActivity(REVIEW_ACTIVITY, input.listingId, input.attendeeId, tx);
    return { kind: "resolved" };
  });
};
