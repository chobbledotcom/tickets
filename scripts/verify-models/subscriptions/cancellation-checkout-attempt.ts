/** One real rejected or placeholder delivery and its selected boundary faults. */
import { execute } from "#db/client.ts";
import { paymentReferenceIndex } from "#db/payment-reference-store.ts";
import { reserveSession } from "#db/processed-payments.ts";
import { placeholderRefund } from "#payment/placeholder-refund.ts";
import type { ProviderRead } from "#payment/provider-read.ts";
import type { SessionRejection } from "#payment/validated-session.ts";
import {
  findHeldAnchor,
  finishPlaceholderRefund,
  loadRefundResume,
  type PlaceholderFailureResult,
} from "#routes/api/payment-processing/placeholder-resume.ts";
import { settleRejectedSubscription } from "#routes/api/payment-processing/rejected-subscription.ts";
import {
  CHECKOUT_SESSION,
  type CheckoutProbe,
  checkoutReference,
  checkoutStart,
  seedHonouredCheckout,
} from "#scripts/verify-models/subscriptions/cancellation-checkout-fixture.ts";
import type { CancellationFault } from "#scripts/verify-models/subscriptions/cancellation-facts.ts";
import {
  MODEL_TIME,
  providerSubscription,
} from "#scripts/verify-models/subscriptions/environment.ts";
import type { ValidatedPaymentSession } from "#shared/payments.ts";
import { requireValue } from "#shared/required-value.ts";
import type {
  SubscriptionStart,
  SubscriptionStatus,
} from "#shared/subscriptions/plan.ts";

export type CheckoutCase = {
  scenario: string;
  shape?: "valid" | "unreadable" | "foreign";
  start?: SubscriptionStatus;
  observedStart?: SubscriptionStart;
  end?: SubscriptionStatus;
  cancelRefused?: boolean;
  readRefused?: boolean;
  refusal?: ProviderRead<never>;
  retry?: boolean;
  placeholder?: boolean;
  interruption?: boolean;
  protected?: "booked" | "orphaned" | "occupied" | "anchorless";
  blankReference?: boolean;
};

/** Booked and orphaned fixtures intentionally have no historical HTTP result. */
export const seedCheckoutDisposition = async (
  sample: CheckoutCase,
): Promise<void> => {
  if (sample.protected === "booked" || sample.protected === "orphaned")
    await seedHonouredCheckout(sample.protected === "orphaned");
  if (sample.protected === "occupied") await reserveSession(CHECKOUT_SESSION);
};

/** The same callback has three deliveries when it can retain unfinished work. */
export const checkoutPasses = (sample: CheckoutCase): number =>
  sample.retry ||
  sample.placeholder ||
  sample.interruption ||
  sample.protected === "anchorless"
    ? 3
    : 1;

export const configureCheckoutAttempt = (
  sample: CheckoutCase,
  attempt: number,
  probe: CheckoutProbe,
): void => {
  const firstRefusal =
    attempt === 1 &&
    (sample.retry || sample.placeholder || sample.protected === "anchorless");
  probe.canEnd = !firstRefusal;
  probe.cancelRefused = firstRefusal || (sample.cancelRefused ?? false);
  probe.readRefused = firstRefusal || (sample.readRefused ?? false);
  probe.observedStatus = sample.end ?? "canceled";
  if (sample.refusal !== undefined) probe.refusal = sample.refusal;
};

/** Only exact production refusals become facts. Unexpected errors escape. */
const expectedCheckoutFailure = (
  error: unknown,
  sample: CheckoutCase,
): boolean => {
  if (!(error instanceof Error)) return false;
  const start = sample.observedStart ?? checkoutStart(sample.start);
  const refused = sample.refusal ?? {
    reason: "rejected_request",
    status: "invalid",
  };
  const observed = {
    resource: providerSubscription({
      ...start,
      status: sample.end ?? "canceled",
    }),
    status: "found",
  };
  const errors = new Set([
    `Failed checkout subscription ${start.id} did not end: ${JSON.stringify(refused)}`,
  ]);
  if (sample.end !== undefined)
    errors.add(
      `Failed checkout subscription ${start.id} did not end: ${JSON.stringify(observed)}`,
    );
  if (sample.interruption)
    errors.add(`Money for session ${CHECKOUT_SESSION} could not be recorded`);
  return errors.has(error.message);
};

const completePlaceholder = async (
  rejection: SessionRejection,
): Promise<PlaceholderFailureResult> => {
  const resume = await loadRefundResume(
    checkoutReference,
    CHECKOUT_SESSION,
    () => MODEL_TIME,
  );
  const target = requireValue(
    resume.target,
    "Placeholder fixture lost held work",
  );
  const session: ValidatedPaymentSession = {
    amountTotal: 600,
    createdAt: MODEL_TIME,
    currency: "GBP",
    id: CHECKOUT_SESSION,
    metadata: rejection.metadata,
    paymentReference: checkoutReference.reference,
    paymentStatus: "paid",
    provider: "stripe",
    subscription: requireValue(
      rejection.subscription,
      "Placeholder subscription missing",
    ),
  };
  return finishPlaceholderRefund(session, {
    ...target,
    listingId: 1,
    referenceIndexes: [await paymentReferenceIndex(checkoutReference)],
    sessionId: CHECKOUT_SESSION,
    spec: placeholderRefund("malformed_charge")(
      "Synthetic rejected subscription",
    ),
  });
};

export type CheckoutAttemptResult = { threw: boolean; refunded: boolean };

/** Run the public orchestration, not a manually assembled cancellation/refund. */
const invokeCheckout = async (
  sample: CheckoutCase,
  rejection: SessionRejection,
  entrypoint: string,
): Promise<CheckoutAttemptResult> => {
  try {
    const result =
      entrypoint === "placeholder"
        ? await completePlaceholder(rejection)
        : await settleRejectedSubscription(rejection);
    return { refunded: result.refunded === true, threw: false };
  } catch (error) {
    if (!expectedCheckoutFailure(error, sample)) throw error;
    return { refunded: false, threw: true };
  }
};

/** A returned refund with failed ledger insertion leaves held recoverable work. */
export const executeCheckoutAttempt = async (
  sample: CheckoutCase,
  attempt: number,
  rejection: SessionRejection,
  entrypoint: string,
): Promise<CheckoutAttemptResult> => {
  const interrupted = sample.interruption && attempt === 1;
  if (interrupted)
    await execute(`CREATE TRIGGER model_checkout_fault BEFORE INSERT ON transfers
    WHEN NEW.kind = 'refund_cash' BEGIN SELECT RAISE(ABORT, 'model_checkout_ledger_fault'); END`);
  try {
    return await invokeCheckout(sample, rejection, entrypoint);
  } finally {
    if (interrupted) await execute("DROP TRIGGER model_checkout_fault");
  }
};

/** Simulate faulty persisted output before extraction, not edited TLA text. */
export const tamperCheckoutReadback = async (
  sample: CheckoutCase,
  attempt: number,
  fault: CancellationFault,
): Promise<void> => {
  if (
    fault === "anchorless-plan-loss" &&
    sample.protected === "anchorless" &&
    attempt === 2
  )
    await execute("DELETE FROM listing_attendees WHERE subscription_id = ?", [
      (sample.observedStart ?? checkoutStart(sample.start)).id,
    ]);
  if (sample.scenario !== "retry" || attempt !== 3) return;
  switch (fault) {
    case "false-local-completion":
      await execute("DELETE FROM transfers WHERE kind = 'refund_cash'");
      break;
    case "duplicate-refund":
      await execute(`INSERT INTO transfers (source_type, source_id, dest_type, dest_id, amount, occurred_at, recorded_at, reference, event_group, kind, memo, reverses_group, posted_by)
        SELECT source_type, source_id, dest_type, dest_id, amount, occurred_at, recorded_at, reference || '_duplicate', event_group || '_duplicate', kind, memo, reverses_group, posted_by FROM transfers WHERE kind = 'refund_cash'`);
      break;
  }
};

/** Remove only the anchor after retaining a failed checkout's actual plan. */
export const removeCheckoutAnchor = async (
  sample: CheckoutCase,
  attempt: number,
): Promise<void> => {
  if (sample.protected !== "anchorless" || attempt !== 1) return;
  const anchor = requireValue(
    (await findHeldAnchor(checkoutReference, CHECKOUT_SESSION)).held,
    "Anchorless fixture has no anchor to remove",
  );
  await execute("DELETE FROM processed_payments WHERE payment_session_id = ?", [
    anchor.record.sessionId,
  ]);
};
