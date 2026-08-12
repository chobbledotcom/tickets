/**
 * Everything one payment row remembers besides its own resolution. The
 * `failure_data` slot holds ONE record with a field per concern — the claim a
 * run holds, the marker saying the owner must look, the terminal outcome a
 * later delivery replays — so a writer can change its own field and leave the
 * others exactly as it found them.
 *
 * This module is pure: it says what the record means and how it reads and
 * writes. Who may change it is the claim's job.
 */

import * as v from "valibot";
import {
  PaymentReviewCaseSchema,
  PaymentReviewReasonSchema,
} from "#shared/payment/review.ts";
import { integerAtLeast } from "#shared/validation/number.ts";
import { defineStoredJson } from "#shared/validation/stored-json.ts";

/** Whether a provider can safely repeat one exact refund request. */
export const RefundProviderCapabilitySchema = v.picklist(["keyed", "keyless"]);
export type RefundProviderCapability = v.InferOutput<
  typeof RefundProviderCapabilitySchema
>;

const SortedAttendeeIdsSchema = v.pipe(
  v.array(integerAtLeast(1)),
  v.minLength(1),
  v.check(
    (ids) => ids.every((id, index) => index === 0 || ids[index - 1]! < id),
    "Refund claim attendee ids must be sorted and unique",
  ),
);

const refundClaimFields = {
  attendeeIds: SortedAttendeeIdsSchema,
  commandId: v.string(),
  scope: v.literal("attendee_set"),
  writtenAt: v.string(),
};

const providerReadyClaim = <TPhase extends "ready" | "send_armed">(
  phase: TPhase,
) =>
  v.strictObject({
    ...refundClaimFields,
    capability: RefundProviderCapabilitySchema,
    phase: v.literal(phase),
  });

/**
 * One refund command's hold on this row. The attendee ids name the people who
 * initiated this exact reference group, while the payment row itself still
 * names the person who owns that physical row. The phase says whether a
 * provider call definitely has not been armed or may already have escaped.
 */
export const RefundClaimSchema = v.variant("phase", [
  v.strictObject({
    ...refundClaimFields,
    phase: v.literal("checking"),
  }),
  providerReadyClaim("ready"),
  providerReadyClaim("send_armed"),
]);
export type RefundClaim = v.InferOutput<typeof RefundClaimSchema>;
export type RefundClaimPhase = RefundClaim["phase"];

/** The handled payment failure a later redirect or webhook retry replays —
 *  message, status, and whether a refund was already issued — without
 *  re-validating the listing or re-attempting the refund. `error` can embed an
 *  encrypted-at-rest listing name, so the whole record is stored encrypted;
 *  keep it free of anything that must not round-trip through that key. */
export const StoredPaymentFailureSchema = v.strictObject({
  error: v.string(),
  refunded: v.optional(v.boolean()),
  status: v.optional(v.pipe(v.number(), v.safeInteger())),
});
export type StoredPaymentFailure = v.InferOutput<
  typeof StoredPaymentFailureSchema
>;

/**
 * Money the provider sent back that our books do not have.
 *
 * Its own field because none of the others means it. A claim says someone is
 * working on this; an outcome says it ended; a review marker says the records
 * disagree. "The money moved and nobody wrote it down" is a fourth thing, and
 * it is the one an operator has to act on — so the row that proves it has to
 * survive until they do.
 */
export const UnrecordedRefundSchema = v.strictObject({
  returnedAt: v.string(),
});
export type UnrecordedRefund = v.InferOutput<typeof UnrecordedRefundSchema>;

/** The whole record. Every field is optional because a row carries only the
 *  concerns it has reached: a claim without an outcome while a run works, an
 *  outcome without a claim once one finishes. */
const PaymentRowStateSchema = v.strictObject({
  claim: v.optional(RefundClaimSchema),
  outcome: v.optional(StoredPaymentFailureSchema),
  review: v.optional(PaymentReviewCaseSchema),
  unrecorded: v.optional(UnrecordedRefundSchema),
});
export type PaymentRowState = v.InferOutput<typeof PaymentRowStateSchema>;

const LegacyPaymentRowStateSchema = v.strictObject({
  claim: v.optional(RefundClaimSchema),
  outcome: v.optional(StoredPaymentFailureSchema),
  review: v.optional(PaymentReviewReasonSchema),
  unrecorded: v.optional(UnrecordedRefundSchema),
});
type LegacyPaymentRowState = v.InferOutput<
  typeof LegacyPaymentRowStateSchema
>;

/** A row carrying nothing yet. */
export const EMPTY_ROW_STATE: PaymentRowState = {};

const rowStateJson = defineStoredJson(PaymentRowStateSchema);
const legacyRowStateJson = defineStoredJson(LegacyPaymentRowStateSchema);
const legacyFailureJson = defineStoredJson(StoredPaymentFailureSchema);

const upgradeLegacyReview = (
  state: LegacyPaymentRowState,
): PaymentRowState => {
  const { review, ...kept } = state;
  return review === undefined
    ? kept
    : {
        ...kept,
        review: {
          caseId: `legacy:${review.kind}`,
          reason: review,
        },
      };
};

/** Read the record out of a decrypted slot. Rows written before it existed
 *  hold a bare terminal failure, read as an outcome-only record — a
 *  stored-format boundary is the one place a compatibility read belongs. */
export const readRowState = (
  stored: string,
  context: string,
): PaymentRowState => {
  const parsed: unknown = JSON.parse(stored);
  if (v.is(StoredPaymentFailureSchema, parsed)) {
    return { outcome: legacyFailureJson.read(stored, context) };
  }
  return v.is(PaymentRowStateSchema, parsed)
    ? rowStateJson.read(stored, context)
    : upgradeLegacyReview(legacyRowStateJson.read(stored, context));
};

/** Write the record back out. */
export const writeRowState = (
  state: PaymentRowState,
  context: string,
): string => rowStateJson.write(state, context);

/** Whether this record holds nothing at all, and so should be stored as the
 *  empty slot rather than as an empty JSON object. */
export const isEmptyRowState = (state: PaymentRowState): boolean =>
  state.claim === undefined &&
  state.outcome === undefined &&
  state.review === undefined &&
  state.unrecorded === undefined;
