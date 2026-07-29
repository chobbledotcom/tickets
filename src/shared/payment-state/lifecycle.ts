import * as v from "valibot";
import {
  IS_THE_READING_ITSELF,
  PaymentConflictSchema,
} from "#shared/payment-state/conflict.ts";
import type { ObservationOutcome } from "#shared/payment-state/diagnose.ts";
import { hasSettled, outcomeOf } from "#shared/payment-state/diagnose.ts";
import {
  PaymentObservationSchema,
  ProviderUnavailableReasonSchema,
} from "#shared/payment-state/observation.ts";
import {
  ProviderResourceSchema,
  sameProviderResource,
} from "#shared/payment-state/resources.ts";
import {
  CASE_STATES,
  PAYMENT_STATES,
  REFUND_STATES,
} from "#shared/payment-state/words.ts";

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

/** What the reading beside an answer actually comes to. Asking the one shared
 *  judgement, rather than working it out again here, is what stops a stored
 *  answer from saying one thing while the resolver would say another about the
 *  very same reading. */
const readingComesTo =
  (kind: ObservationOutcome["kind"]) =>
  (observation: Observation): boolean =>
    hasSettled(observation) && outcomeOf(observation).kind === kind;

export const PaymentResolutionSchema = v.variant("status", [
  answerFromReading(
    "ready",
    readingComesTo("ready"),
    "A payment is only ready when its reading says the money is settled",
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
          : readingComesTo("refund_pending")(answer.observation),
      "What a payment is waiting for must match what its reading says",
    ),
  ),
  answerFromReading(
    "fully_refunded",
    readingComesTo("fully_refunded"),
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
    // Asking the reading the same question the resolver asked it. Without
    // this, a problem could name one thing while the reading beside it shows
    // another, and the owner would be sent after the wrong money.
    v.check((resolution) => {
      const reading = resolution.observation;
      if (reading === undefined) return true;
      if (!hasSettled(reading)) return false;
      const outcome = outcomeOf(reading);
      return (
        outcome.kind === "conflict" &&
        outcome.issue.kind === resolution.issue.kind
      );
    }, "A problem must be the one its own reading shows"),
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
