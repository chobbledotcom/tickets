import * as v from "valibot";
import {
  PaymentObservationSchema,
  ProviderInvalidReasonSchema,
  ProviderUnavailableReasonSchema,
} from "#shared/payment-state/observation.ts";
import type {
  ChargeLeg,
  RefundObservation,
} from "#shared/payment-state/resources.ts";
import {
  gaveEverythingBack,
  ProviderResourceSchema,
  sameProviderResource,
} from "#shared/payment-state/resources.ts";
import {
  CASE_STATES,
  PAYMENT_STATES,
  REFUND_STATES,
} from "#shared/payment-state/words.ts";
import { kindObject } from "#shared/validation/kind.ts";

export const PaymentConflictSchema = v.variant("kind", [
  v.strictObject({
    kind: v.literal("invalid_provider_data"),
    reason: ProviderInvalidReasonSchema,
  }),
  kindObject("missing_resource"),
  kindObject("resource_mismatch"),
  kindObject("currency_mismatch"),
  kindObject("provider_total_mismatch"),
  kindObject("partial_charge"),
  kindObject("capture_total_mismatch"),
  kindObject("refund_exceeds_capture"),
  kindObject("duplicate_charge"),
  kindObject("multiple_charges"),
  kindObject("duplicate_refund"),
  kindObject("multiple_pending_refunds"),
  kindObject("paid_without_charge"),
  kindObject("partial_refund"),
  kindObject("failed_refund"),
]);
export type PaymentConflict = v.InferOutput<typeof PaymentConflictSchema>;

/** Whether the reading itself is the problem. Those two are all we have when
 *  a read fails, so they come with nothing to show; every other problem was
 *  spotted *in* a reading, and must bring it. Listing every kind means a new
 *  one cannot be added without saying which it is. */
const IS_THE_READING_ITSELF: Record<PaymentConflict["kind"], boolean> = {
  capture_total_mismatch: false,
  currency_mismatch: false,
  duplicate_charge: false,
  duplicate_refund: false,
  failed_refund: false,
  invalid_provider_data: true,
  missing_resource: true,
  multiple_charges: false,
  multiple_pending_refunds: false,
  paid_without_charge: false,
  partial_charge: false,
  partial_refund: false,
  provider_total_mismatch: false,
  refund_exceeds_capture: false,
  resource_mismatch: false,
};

export const PaymentPendingReasonSchema = v.picklist([
  "payment_pending",
  "refund_pending",
]);
export type PaymentPendingReason = v.InferOutput<
  typeof PaymentPendingReasonSchema
>;

export const PaymentIgnoreReasonSchema = v.picklist([
  "not_ours",
  "payment_failed",
  "unproven_invalid_data",
  "unproven_missing_resource",
]);
export type PaymentIgnoreReason = v.InferOutput<
  typeof PaymentIgnoreReasonSchema
>;

type Observation = v.InferOutput<typeof PaymentObservationSchema>;

/**
 * An answer that carries the reading it was worked out from, and only holds
 * when that reading still says so. Written once because the two answers using
 * it are the ones nothing may fake: a payment ready to book, and money finally
 * given back.
 */
const answerFromReading = <const Status extends string>(
  status: Status,
  readingSaysSo: (observation: Observation) => boolean,
  message: string,
) =>
  v.pipe(
    v.strictObject({
      observation: PaymentObservationSchema,
      status: v.literal(status),
    }),
    v.check((answer) => readingSaysSo(answer.observation), message),
  );

/** Fully refunded means every charge has given back everything. Without this,
 *  money still held on one charge could be filed as finally returned. A
 *  reading with no charge at all took nothing to give back. */
const everythingCameBack = (observation: Observation): boolean =>
  observation.status === "paid" &&
  observation.charges !== undefined &&
  observation.charges.every(gaveEverythingBack);

/** Asks whether any refund anywhere in a reading is in the given state. A
 *  reading with no charge took nothing, so no refund can belong to it. */
const someRefundIs =
  (status: RefundObservation["status"]) =>
  (observation: Observation): boolean =>
    observation.charges?.some((charge) =>
      charge.refunds.some((refund) => refund.status === status),
    ) ?? false;

/** Money on its way back somewhere in this reading. */
const aRefundIsStillGoing = someRefundIs("pending");

/** A refund the provider tried and could not finish. The money is still here,
 *  but somebody asked for it back and that did not happen — which the resolver
 *  raises for the owner rather than treating as a booking to make. */
const aRefundFailed = someRefundIs("failed");

/** A charge that has kept every penny it took. */
const nothingGivenBack = (charge: ChargeLeg): boolean =>
  charge.confirmedRefunded.amount === 0;

/** Money was taken, and every charge has kept what it took. A paid reading
 *  with no charge at all does not describe money that can be booked against —
 *  it is a payment nobody can find, which is a problem for the owner. */
const tookMoneyAndKeptIt = (observation: Observation): boolean =>
  observation.charges?.every(nothingGivenBack) ?? false;

/** The buyer paid and the money has stayed paid: none given back, none on its
 *  way back, and none that somebody tried to send back and could not. Money
 *  part-returned is a problem for the owner, money fully returned is its own
 *  answer, money still going is waited on, and a refund that failed is the
 *  owner's to look at — so a reading in any of those states is not a booking
 *  waiting to be made. */
const paidAndStayedPaid = (observation: Observation): boolean =>
  observation.status === "paid" &&
  tookMoneyAndKeptIt(observation) &&
  !aRefundIsStillGoing(observation) &&
  !aRefundFailed(observation);

/** Ready means the money question is settled: the buyer paid and the money
 *  stayed paid, or nothing was owed and so nothing was taken. A reading still
 *  going, or one that failed, would otherwise let an unpaid checkout be
 *  treated as ready to book. */
const moneyQuestionSettled = (observation: Observation): boolean =>
  paidAndStayedPaid(observation) ||
  (observation.status === "no_payment_required" &&
    observation.expected.amount === 0 &&
    observation.charges === undefined);

export const PaymentResolutionSchema = v.variant("status", [
  answerFromReading(
    "ready",
    moneyQuestionSettled,
    "A payment is only ready when it was paid, or nothing was owed",
  ),
  v.pipe(
    v.strictObject({
      observation: PaymentObservationSchema,
      reason: PaymentPendingReasonSchema,
      status: v.literal("pending"),
    }),
    // Waiting on the payment means the reading is still going; waiting on a
    // refund means the money was taken and a refund really is on its way back.
    // Checked apart, a settled reading with nothing in flight could be left on
    // the retry path forever, looked at again and again with nothing to find.
    v.check(
      (answer) =>
        answer.reason === "payment_pending"
          ? answer.observation.status === "pending"
          : answer.observation.status === "paid" &&
            aRefundIsStillGoing(answer.observation),
      "What a payment is waiting for must match what its reading says",
    ),
  ),
  answerFromReading(
    "fully_refunded",
    everythingCameBack,
    "A payment is only fully refunded once a charge has given it all back",
  ),
  v.strictObject({
    reason: ProviderUnavailableReasonSchema,
    resource: ProviderResourceSchema,
    status: v.literal("retry"),
  }),
  v.pipe(
    v.strictObject({
      issue: PaymentConflictSchema,
      observation: v.optional(PaymentObservationSchema),
      resource: ProviderResourceSchema,
      status: v.literal("conflict"),
    }),
    v.check(
      (resolution) =>
        resolution.observation === undefined ||
        sameProviderResource(
          resolution.resource,
          resolution.observation.session,
        ),
      "A problem must name the same checkout its evidence describes",
    ),
    v.check(
      (resolution) =>
        IS_THE_READING_ITSELF[resolution.issue.kind] ===
        (resolution.observation === undefined),
      "A problem must bring the reading that shows it, unless the reading is the problem",
    ),
  ),
  v.strictObject({
    reason: PaymentIgnoreReasonSchema,
    resource: ProviderResourceSchema,
    status: v.literal("ignore"),
  }),
]);
export type PaymentResolution = v.InferOutput<typeof PaymentResolutionSchema>;

export const PaymentSessionStateSchema = v.picklist(PAYMENT_STATES);
export type PaymentSessionState = v.InferOutput<
  typeof PaymentSessionStateSchema
>;

export const PaymentCaseStateSchema = v.picklist(CASE_STATES);
export type PaymentCaseState = v.InferOutput<typeof PaymentCaseStateSchema>;

/** Where a refund has got to. "unknown" belongs only to money copied from an
 *  older version, whose record never said what became of its refund. */
export const PaymentRefundStateSchema = v.picklist(REFUND_STATES);
export type PaymentRefundState = v.InferOutput<typeof PaymentRefundStateSchema>;
