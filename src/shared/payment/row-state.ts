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
import { PaymentConflictSchema } from "#shared/payment/conflict.ts";
import { defineStoredJson } from "#shared/validation/stored-json.ts";

/** Whether a second attempt under this claim would land on the money twice.
 *  `keyed` takes an idempotency key, so a lost call may be re-run and the
 *  claim released on any answer. `keyless` (SumUp) has no such promise, so a
 *  lost answer keeps the claim until fresh evidence settles it. */
export const RefundCapabilitySchema = v.picklist(["keyed", "keyless"]);
export type RefundCapability = v.InferOutput<typeof RefundCapabilitySchema>;

/**
 * One refund run's hold on this row, re-claimable only by another run that
 * takes the same attendee's whole reference set again. `scope` is the
 * discriminator a second kind of run is added under; today only the admin
 * runs claim, so it has one value.
 */
export const RefundClaimSchema = v.variant("scope", [
  v.strictObject({
    attendeeId: v.pipe(v.number(), v.safeInteger()),
    capability: RefundCapabilitySchema,
    scope: v.literal("attendee_set"),
    writtenAt: v.string(),
  }),
]);
export type RefundClaim = v.InferOutput<typeof RefundClaimSchema>;

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
  review: v.optional(PaymentConflictSchema),
  unrecorded: v.optional(UnrecordedRefundSchema),
});
export type PaymentRowState = v.InferOutput<typeof PaymentRowStateSchema>;

/** A row carrying nothing yet. */
export const EMPTY_ROW_STATE: PaymentRowState = {};

const rowStateJson = defineStoredJson(PaymentRowStateSchema);
const legacyFailureJson = defineStoredJson(StoredPaymentFailureSchema);

/** Read the record out of a decrypted slot. Rows written before it existed
 *  hold a bare terminal failure, read as an outcome-only record — a
 *  stored-format boundary is the one place a compatibility read belongs. */
export const readRowState = (
  stored: string,
  context: string,
): PaymentRowState => {
  const parsed: unknown = JSON.parse(stored);
  return v.is(StoredPaymentFailureSchema, parsed)
    ? { outcome: legacyFailureJson.read(stored, context) }
    : rowStateJson.read(stored, context);
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
