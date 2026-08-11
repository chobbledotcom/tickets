/**
 * Everything one payment row remembers besides its own resolution.
 *
 * A row's `failure_data` slot holds ONE record with a separate field per
 * concern: the claim a refund run holds while it works, the marker saying the
 * owner still has to look at this money, and the terminal outcome a later
 * delivery replays. Keeping them in one record is what lets a writer change its
 * own field and leave the others exactly as it found them, so an operator
 * retrying a reference whose refund failed does not lose the recorded failure.
 *
 * This module is pure: it says what the record means and how it reads and
 * writes. Who may change it, and under what conditions, is the claim's job.
 */

import * as v from "valibot";
import { PaymentConflictSchema } from "#shared/payment/conflict.ts";
import { defineStoredJson } from "#shared/validation/stored-json.ts";

/**
 * Whether a second attempt under this claim would land on the money twice.
 *
 * `keyed` providers take an idempotency key, so re-running a lost call is safe
 * and the claim may be released on any recorded answer. `keyless` (SumUp) has
 * no such promise, so a claim whose answer was lost stays standing until fresh
 * evidence says what the money did. `unresolved` is a claim on a reference
 * whose provider is not yet known — no release rule applies to it but
 * staleness, because guessing either way is unsafe.
 */
export const RefundCapabilitySchema = v.picklist([
  "keyed",
  "keyless",
  "unresolved",
]);
export type RefundCapability = v.InferOutput<typeof RefundCapabilitySchema>;

/**
 * One refund run's hold on this row. `attendeeId` is present only for an
 * `attendee_set` claim, which is re-claimable only by another run that takes
 * the same attendee's whole reference set again.
 */
export const RefundClaimSchema = v.variant("scope", [
  v.strictObject({
    attendeeId: v.pipe(v.number(), v.safeInteger()),
    capability: RefundCapabilitySchema,
    scope: v.literal("attendee_set"),
    writtenAt: v.string(),
  }),
  v.strictObject({
    capability: RefundCapabilitySchema,
    scope: v.literal("callback"),
    writtenAt: v.string(),
  }),
]);
export type RefundClaim = v.InferOutput<typeof RefundClaimSchema>;

/**
 * The subset of a handled payment failure we persist so a later redirect or
 * webhook retry replays the same terminal result (user-facing message, HTTP
 * status, and whether a refund was already issued) without re-validating the
 * listing or re-attempting the refund.
 *
 * `error` can embed an encrypted-at-rest listing name, so this whole record is
 * stored encrypted. Keep this shape free of any field that shouldn't
 * round-trip through the DB encryption key.
 */
export const StoredPaymentFailureSchema = v.strictObject({
  error: v.string(),
  refunded: v.optional(v.boolean()),
  status: v.optional(v.pipe(v.number(), v.safeInteger())),
});
export type StoredPaymentFailure = v.InferOutput<
  typeof StoredPaymentFailureSchema
>;

/** The whole record. Every field is optional because a row carries only the
 *  concerns it has reached: a claim without an outcome while a run works, an
 *  outcome without a claim once one finishes. */
const PaymentRowStateSchema = v.strictObject({
  claim: v.optional(RefundClaimSchema),
  outcome: v.optional(StoredPaymentFailureSchema),
  review: v.optional(PaymentConflictSchema),
});
export type PaymentRowState = v.InferOutput<typeof PaymentRowStateSchema>;

/** A row carrying nothing yet. */
export const EMPTY_ROW_STATE: PaymentRowState = {};

const rowStateJson = defineStoredJson(PaymentRowStateSchema);
const legacyFailureJson = defineStoredJson(StoredPaymentFailureSchema);

/**
 * Read the record out of a decrypted slot.
 *
 * Rows written before this record existed hold a bare terminal failure, so that
 * shape is accepted and read as an outcome-only record. This is a stored-format
 * boundary, which is the one place a compatibility read belongs: the rows are
 * already on disk and cannot be asked to change shape.
 */
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
  state.review === undefined;
