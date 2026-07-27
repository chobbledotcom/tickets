/* jscpd:ignore-start -- imports */

import { t } from "#i18n";
import {
  COMPLETION_RETRY_MS,
  type CompletionCurrent,
  type CompletionHandler,
  type CompletionStep,
  completedStep,
  completionAttendeeId,
  definePaymentCompletion,
  finishCompletion,
  logCompletionActivity,
} from "#routes/api/payment-processing/completion-runtime.ts";
import {
  refundedNoteText,
  refundNotificationForCode,
} from "#routes/api/payment-processing/refunds.ts";
import type {
  PaymentFailureResult,
  PaymentWork,
} from "#routes/api/webhook-types.ts";
import type { TxScope } from "#shared/db/client.ts";
import {
  requirePaymentCompletionRecordId,
  runPaymentCompletionDbEffect,
} from "#shared/db/payments/completion-effects.ts";
import { createSystemNote, updateSystemNote } from "#shared/db/system-notes.ts";
import { sendNtfyError } from "#shared/ntfy.ts";
import {
  type PlaceholderRefundCompletion,
  type PlaceholderRefundEffect,
  PlaceholderRefundEffectSchema,
} from "#shared/payment-completion.ts";
import { refundChargesKeepingClaim } from "#shared/payment-runtime/refund.ts";
import { recordPlaceholderRefund } from "#shared/refund-ledger.ts";

/* jscpd:ignore-end */

const refundResult = (
  resolutions: readonly NonNullable<PaymentFailureResult["refund"]>[],
): NonNullable<PaymentFailureResult["refund"]> => {
  const resolution =
    resolutions.find((item) => item.status !== "completed") ?? resolutions[0];
  if (resolution === undefined) throw new Error("Refund has no resolution");
  return resolution;
};

export const placeholderFailure = (
  plan: Pick<PlaceholderRefundCompletion, "facts">,
  resolutions: readonly NonNullable<PaymentFailureResult["refund"]>[],
  state: PaymentWork["payment"]["state"],
): PaymentFailureResult => {
  const refund = refundResult(resolutions);
  const bookingSaved = t("payment.error.booking_saved");
  return {
    detail: plan.facts.spec.detail,
    error:
      refund.status === "completed"
        ? bookingSaved
        : `${bookingSaved} ${t("payment.error.refund_being_arranged")}`,
    refund,
    status:
      refund.status === "partial" || state === "needs_action"
        ? 409
        : refund.status === "failed"
          ? 503
          : 200,
    success: false,
  };
};

export interface PlaceholderCompletionContext {
  current: CompletionCurrent;
  plan: PlaceholderRefundCompletion;
  work: PaymentWork;
}

const placeholderNote = (
  context: PlaceholderCompletionContext,
  status: "pending" | "completed",
): string =>
  refundedNoteText(
    completionAttendeeId(context.current),
    context.plan.facts.spec,
    status,
    context.work.session.paymentReference,
  );

export type PlaceholderCompletionActions = Record<
  PlaceholderRefundEffect,
  (
    context: PlaceholderCompletionContext,
  ) => Promise<
    CompletionStep<PaymentFailureResult, PlaceholderRefundCompletion>
  >
>;

const ledgerFacts = (context: PlaceholderCompletionContext) => ({
  amount: context.plan.facts.amount,
  attendeeId: completionAttendeeId(context.current),
  eventId: context.current.payment.id,
  listingId: context.plan.facts.listingId,
  occurredAt: context.plan.facts.occurredAt,
});

const runPlaceholderDbEffect = async (
  context: PlaceholderCompletionContext,
  effect: PlaceholderRefundEffect,
  work: (transaction: TxScope) => Promise<number | null>,
): Promise<
  CompletionStep<PaymentFailureResult, PlaceholderRefundCompletion>
> => {
  await runPaymentCompletionDbEffect(context.current.claim, effect, work);
  return completedStep(context.current);
};

const recordPlaceholderLedger = async (
  context: PlaceholderCompletionContext,
  refunded: boolean,
): Promise<
  CompletionStep<PaymentFailureResult, PlaceholderRefundCompletion>
> => {
  const posted = await recordPlaceholderRefund(
    ledgerFacts(context),
    context.plan.facts.spec.code,
    refunded,
  );
  if (!posted.posted) {
    const kind = refunded ? "refund" : "payment";
    throw new Error(`Placeholder ${kind} ledger was not stored`);
  }
  return completedStep(context.current);
};

export const placeholderCompletionActions: PlaceholderCompletionActions = {
  completed_note: (context) =>
    runPlaceholderDbEffect(context, "completed_note", async (transaction) => {
      const noteId = await requirePaymentCompletionRecordId(
        transaction,
        context.current.payment.id,
        "pending_note",
      );
      await updateSystemNote(
        completionAttendeeId(context.current),
        noteId,
        placeholderNote(context, "completed"),
        transaction,
      );
      return null;
    }),
  operator_alert: async (context) => {
    const code = refundNotificationForCode(context.plan.facts.spec.code);
    if (code !== undefined && (await sendNtfyError(code)) === "failed") {
      throw new Error(
        `Refund alert failed for payment ${context.current.payment.id}`,
      );
    }
    return completedStep(context.current);
  },
  payment_ledger: (context) => recordPlaceholderLedger(context, false),
  pending_note: (context) =>
    runPlaceholderDbEffect(context, "pending_note", (transaction) =>
      createSystemNote(
        completionAttendeeId(context.current),
        placeholderNote(context, "pending"),
        transaction,
      ),
    ),
  provider_refund: async (context) => {
    const attempt = await refundChargesKeepingClaim(
      context.current.payment,
      context.current.claim,
    );
    const current = { claim: attempt.claim, payment: attempt.payment };
    if (!attempt.ok) return { current, error: attempt.error, kind: "failed" };
    const result = placeholderFailure(
      context.plan,
      attempt.resolutions,
      current.payment.state,
    );
    const completion = { ...context.plan, result };
    if (attempt.status === "completed") {
      return completedStep(current, completion);
    }
    return {
      completion,
      current,
      kind: "paused",
      nextReconcileAt:
        attempt.status === "partial"
          ? null
          : attempt.status === "failed"
            ? current.payment.state === "needs_action"
              ? null
              : Date.now()
            : Date.now() + COMPLETION_RETRY_MS,
      result,
    };
  },
  refund_activity: (context) =>
    runPlaceholderDbEffect(context, "refund_activity", async (transaction) => {
      await logCompletionActivity(
        context.current,
        `Automatic refund (${context.plan.facts.spec.code}); booking kept at quantity 0`,
        context.plan.facts.listingId,
        transaction,
      );
      return null;
    }),
  refund_ledger: (context) => recordPlaceholderLedger(context, true),
};

export const completePlaceholderRefund: CompletionHandler<
  PlaceholderCompletionActions,
  PaymentFailureResult
> = definePaymentCompletion<
  PlaceholderRefundEffect,
  PlaceholderRefundCompletion,
  PlaceholderCompletionActions,
  PaymentWork,
  PaymentFailureResult
>({
  actions: placeholderCompletionActions,
  criticalEffects: ["provider_refund"],
  effects: PlaceholderRefundEffectSchema.options,
  finish: async (current, plan) => {
    if (current.payment.state !== "fully_refunded") {
      throw new Error(`Payment ${current.payment.id} refund is not complete`);
    }
    await finishCompletion(current, plan, "fully_refunded");
    return plan.result;
  },
  label: "placeholder",
  matches: (completion): completion is PlaceholderRefundCompletion =>
    completion.kind === "placeholder_refund",
  prepare: (work) => work,
  result: (_current, plan) => plan.result,
  run: (effect, current, plan, work, actions) =>
    actions[effect]({
      current,
      plan,
      work: { ...work, claim: current.claim, payment: current.payment },
    }),
});
