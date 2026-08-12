/** Acknowledging exact payment-review cases without resolving their evidence. */

/* jscpd:ignore-start -- imports */
import { sortStrings } from "#fp";
import { hmacHash } from "#shared/crypto/hashing.ts";
import { logActivity } from "#shared/db/activity-log.ts";
import { withTransaction } from "#shared/db/client.ts";
import {
  loadAttendeeRowStates,
  type PaymentRowRecord,
  paymentRowStateStatement,
  readAttendeeRowStates,
} from "#shared/db/payment-claim.ts";
import { nowIso } from "#shared/now.ts";
import {
  acknowledgePaymentReview,
  type PaymentReviewCase,
} from "#shared/payment/review.ts";
import type { PaymentRowState } from "#shared/payment/row-state.ts";
/* jscpd:ignore-end */

export type AcknowledgePaymentReviewInput = {
  readonly attendeeId: number;
  readonly listingId: number | null;
  readonly reviewIdentity: string;
};

export type AcknowledgePaymentReviewResult =
  | { readonly kind: "acknowledged" }
  | { readonly kind: "already_acknowledged" }
  | { readonly kind: "claim_in_progress" }
  | { readonly kind: "nothing_to_review" }
  | { readonly kind: "review_changed" };

/** The one operator-facing state of an attendee's payment work. */
export type PaymentWorkStatus =
  | "clear"
  | "moving"
  | "needs_money_record"
  | "needs_review";

export type PaymentReviewState =
  | {
      readonly allAcknowledged: boolean;
      readonly identity: string;
      readonly status: "needs_review";
    }
  | {
      readonly status: Exclude<PaymentWorkStatus, "needs_review">;
    };

const REVIEW_ACTIVITY = "Payment review acknowledged by owner";

const WORK_PRIORITY = {
  clear: 0,
  moving: 3,
  needs_money_record: 1,
  needs_review: 2,
} as const satisfies Record<PaymentWorkStatus, number>;

const rowWorkStatus = (row: PaymentRowRecord): PaymentWorkStatus =>
  row.state.claim !== undefined
    ? "moving"
    : row.state.review !== undefined
      ? "needs_review"
      : row.state.unrecorded !== undefined
        ? "needs_money_record"
        : "clear";

const paymentWorkStatus = (
  rows: readonly PaymentRowRecord[],
): PaymentWorkStatus =>
  rows.reduce<PaymentWorkStatus>((chosen, row) => {
    const candidate = rowWorkStatus(row);
    return WORK_PRIORITY[candidate] > WORK_PRIORITY[chosen]
      ? candidate
      : chosen;
  }, "clear");

type ReviewRow = {
  readonly review: PaymentReviewCase;
  readonly row: PaymentRowRecord;
};

const reviewRows = (rows: readonly PaymentRowRecord[]): ReviewRow[] =>
  rows.flatMap((row) =>
    row.state.review === undefined
      ? []
      : [{ review: row.state.review, row }],
  );

/** The form names the complete exact review set, without exposing its facts. */
const reviewIdentity = (reviews: readonly ReviewRow[]): Promise<string> => {
  if (reviews.length === 0) {
    throw new Error("A payment review identity needs at least one review");
  }
  const facts = sortStrings(
    reviews.map(({ review, row }) =>
      JSON.stringify([row.sessionId, review.caseId, review.reason])
    ),
  );
  return hmacHash(`payment-review:1:${JSON.stringify(facts)}`);
};

const stateFromRows = async (
  rows: readonly PaymentRowRecord[],
): Promise<PaymentReviewState> => {
  const status = paymentWorkStatus(rows);
  if (status !== "needs_review") return { status };
  const reviews = reviewRows(rows);
  return {
    allAcknowledged: reviews.every(
      ({ review }) => review.acknowledgedAt !== undefined,
    ),
    identity: await reviewIdentity(reviews),
    status,
  };
};

/** Read the exact review form state shared by link, GET, and POST admission. */
export const getPaymentReviewState = async (
  attendeeId: number,
): Promise<PaymentReviewState> =>
  stateFromRows(await loadAttendeeRowStates([attendeeId]));

/** Read the aggregate payment-work state used by every action decision. */
export const getPaymentWorkStatus = async (
  attendeeId: number,
): Promise<PaymentWorkStatus> =>
  (await getPaymentReviewState(attendeeId)).status;

const acknowledgedState = (
  row: PaymentRowRecord,
  acknowledgedAt: string,
): PaymentRowState => {
  if (row.state.review === undefined) {
    throw new Error(`Payment row ${row.sessionId} has no review to acknowledge`);
  }
  return {
    ...row.state,
    review: acknowledgePaymentReview(row.state.review, acknowledgedAt),
  };
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

/** Acknowledge only the exact review set the owner saw, in one transaction. */
export const acknowledgeCurrentPaymentReview = (
  input: AcknowledgePaymentReviewInput,
): Promise<AcknowledgePaymentReviewResult> =>
  withTransaction(async (tx) => {
    const rows = await readAttendeeRowStates(tx, [input.attendeeId]);
    const state = await stateFromRows(rows);
    if (state.status === "moving") return { kind: "claim_in_progress" };
    if (state.status !== "needs_review") return { kind: "nothing_to_review" };
    if (state.identity !== input.reviewIdentity) {
      return { kind: "review_changed" };
    }
    const changing = reviewRows(rows).filter(
      ({ review }) => review.acknowledgedAt === undefined,
    );
    if (changing.length === 0) return { kind: "already_acknowledged" };

    const acknowledgedAt = nowIso();
    const results = await tx.batch(
      await Promise.all(
        changing.map(({ row }) =>
          paymentRowStateStatement(row, acknowledgedState(row, acknowledgedAt)),
        ),
      ),
    );
    assertEveryRowChanged(
      changing.map(({ row }) => row),
      results.map((result) => result.rowsAffected),
    );
    await logActivity(
      REVIEW_ACTIVITY,
      input.listingId,
      input.attendeeId,
      tx,
    );
    return { kind: "acknowledged" };
  });
