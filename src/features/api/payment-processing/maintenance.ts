/* jscpd:ignore-start */
import { classifySessionIntent } from "#routes/api/payment-processing/classify.ts";
import { processPaymentSession } from "#routes/api/payment-processing/index.ts";
import {
  deferCheckoutStage,
  markCheckoutStagePaid,
  nextCheckoutStageAttemptIn,
  selectDueCheckoutStages,
} from "#shared/db/checkout-stage-recovery.ts";
import {
  type CheckoutStageCleanup,
  loadCheckoutStageByPaymentSession,
} from "#shared/db/checkout-stages.ts";
import { PRUNE_INTERVAL_MS } from "#shared/limits.ts";
import { logDebug } from "#shared/logger.ts";
import {
  MAINTENANCE_MIN_INTERVAL_MS,
  type MaintenanceTaskContext,
} from "#shared/maintenance/definition.ts";
import {
  CHECKOUT_RECOVERY_DATABASE_CALLS,
  CHECKOUT_RECOVERY_EXTERNAL_CALLS,
  CHECKOUT_RECOVERY_FOLLOW_UP_DATABASE_CALLS,
} from "#shared/payment-recovery-costs.ts";
import { getPaymentProvider, type PaymentProvider } from "#shared/payments.ts";
import { closeAndPurgeCheckoutStage } from "#shared/staged-checkout.ts";

/* jscpd:ignore-end */

const attemptFits = (
  stage: CheckoutStageCleanup,
  context: MaintenanceTaskContext,
): boolean => {
  const remaining = context.budget.remaining();
  const database =
    CHECKOUT_RECOVERY_DATABASE_CALLS[stage.state] +
    CHECKOUT_RECOVERY_FOLLOW_UP_DATABASE_CALLS;
  const external = CHECKOUT_RECOVERY_EXTERNAL_CALLS[stage.provider];
  return (
    database <= remaining.database &&
    external <= remaining.external &&
    database + external <= remaining.total
  );
};

const processCheckoutStage = async (
  stage: CheckoutStageCleanup,
  provider: PaymentProvider,
): Promise<void> => {
  if (stage.state === "pending") {
    const result = await closeAndPurgeCheckoutStage(stage, provider);
    if (result === "paid") {
      await markCheckoutStagePaid(stage);
    } else if (result === "kept") {
      await deferCheckoutStage(stage);
    }
    return;
  }

  const session = await provider.retrieveSession(
    stage.paymentSessionId,
    "recovery",
  );
  if (session?.paymentStatus !== "paid") {
    await deferCheckoutStage(stage);
    return;
  }
  const classified = await classifySessionIntent(session);
  if (classified === null) {
    throw new Error(
      `Recovered checkout stage ${stage.paymentSessionId} has no valid payment proof`,
    );
  }
  await processPaymentSession(stage.paymentSessionId, {
    ...classified,
    session,
  });
  const remaining = await loadCheckoutStageByPaymentSession(
    stage.paymentSessionId,
  );
  if (remaining !== null) await deferCheckoutStage(remaining);
};

const recoverCheckoutStage = async (
  stage: CheckoutStageCleanup,
): Promise<void> => {
  try {
    const provider = await getPaymentProvider(stage.provider);
    await processCheckoutStage(stage, provider);
  } catch (error) {
    logDebug(
      "Payment",
      `stage failed (provider=${stage.provider}, session=${stage.paymentSessionId}): ${String(error)}`,
    );
    if (await loadCheckoutStageByPaymentSession(stage.paymentSessionId)) {
      await deferCheckoutStage(stage);
    }
  }
};

/** Recover as much due checkout work as this maintenance claim can safely fit. */
export const recoverCheckoutStages = async (
  context: MaintenanceTaskContext,
): Promise<void> => {
  const stages = await selectDueCheckoutStages();
  for (const stage of stages) {
    if (Date.now() >= context.deadline || !attemptFits(stage, context)) {
      break;
    }
    await recoverCheckoutStage(stage);
  }

  const nextAttemptIn = await nextCheckoutStageAttemptIn();
  if (nextAttemptIn === null || nextAttemptIn >= PRUNE_INTERVAL_MS) return;
  context.requestFollowUp(Math.max(MAINTENANCE_MIN_INTERVAL_MS, nextAttemptIn));
};
