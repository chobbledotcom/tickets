/* jscpd:ignore-start -- imports */
import { mapById, once, requiredMapValue, unique } from "#fp";
import { committedEntries } from "#routes/api/payment-processing/committed-entries.ts";
import {
  deliverNextPaidCompletion,
  preparePaidCompletionDeliveries,
} from "#routes/api/payment-processing/completion-deliveries.ts";
import {
  type CompletionCurrent,
  type CompletionHandler,
  completedStep,
  completionAttendeeId,
  definePaymentCompletion,
  finishCompletion,
  logCompletionActivity,
} from "#routes/api/payment-processing/completion-runtime.ts";
import {
  type CreatedEntry,
  saveSessionAnswers,
} from "#routes/api/payment-processing/create.ts";
import type { PaymentResult, PaymentWork } from "#routes/api/webhook-types.ts";
import type { ModifierApplication } from "#shared/checkout-pricing.ts";
import { formatCurrency } from "#shared/currency.ts";
import { logActivity } from "#shared/db/activityLog.ts";
import type { TxScope } from "#shared/db/client.ts";
import { getStoredListingsWithCountsByIds } from "#shared/db/listings/records.ts";
import { storePaymentCompletionDeliveries } from "#shared/db/payments/completion-deliveries.ts";
import { runPaymentCompletionDbEffect } from "#shared/db/payments/completion-effects.ts";
import {
  type BookingCompletion,
  type BookingCompletionEffect,
  BookingCompletionEffectSchema,
  type PromoActivity,
  paymentCompletionResult,
} from "#shared/payment-completion.ts";
import type { ModifierSpec } from "#shared/payments.ts";
import { logRegistrationActivities } from "#shared/webhook.ts";
/* jscpd:ignore-end */

export const promoActivities = (
  specs: ModifierSpec[],
  applications: ModifierApplication[],
): PromoActivity[] => {
  const byId = new Map(
    applications.map((application) => [application.modifierId, application]),
  );
  return specs.map((spec) => ({
    delta: requiredMapValue(
      byId,
      spec.id,
      `Priced order has no application for modifier ${spec.id}`,
    ).delta,
    modifierId: spec.id,
    name: spec.name,
  }));
};

const requiredFirst = <T>(values: readonly T[], label: string): T => {
  const value = values[0];
  if (value === undefined)
    throw new Error(`Payment completion has no ${label}`);
  return value;
};

const completionEntries = (
  work: PaymentWork,
  plan: BookingCompletion,
): (() => Promise<CreatedEntry[]>) =>
  once(async () => {
    const current = { claim: work.claim, payment: work.payment };
    const ticketToken = work.payment.ticketTokens?.[0];
    if (ticketToken === undefined) {
      throw new Error(`Payment ${work.payment.id} has no completion ticket`);
    }
    const ids = unique(plan.input.items.map((item) => item.e));
    const listings = await getStoredListingsWithCountsByIds(ids);
    const byId = mapById((listing: (typeof listings)[number]) => listing)(
      listings,
    );
    const items = plan.input.items.map((item) => ({
      expectedPrice: item.p,
      item,
      listing: requiredMapValue(
        byId,
        item.e,
        `Listing ${item.e} was not loaded for payment completion`,
      ),
    }));
    return committedEntries(
      completionAttendeeId(current),
      ticketToken,
      work.session,
      plan.input,
      items,
    );
  });

export interface BookingCompletionContext {
  current: CompletionCurrent;
  entries: () => Promise<CreatedEntry[]>;
  plan: BookingCompletion;
}

export type BookingCompletionActions = Record<
  BookingCompletionEffect,
  (context: BookingCompletionContext) => Promise<boolean>
>;

type BookingSuccess = Extract<PaymentResult, { success: true }>;

const runBookingDbEffect = async (
  context: BookingCompletionContext,
  effect: BookingCompletionEffect,
  work: (transaction: TxScope) => Promise<void>,
): Promise<boolean> => {
  await runPaymentCompletionDbEffect(
    context.current.claim,
    effect,
    async (transaction) => {
      await work(transaction);
      return null;
    },
  );
  return true;
};

const runRegistrationDbEffect = async (
  context: BookingCompletionContext,
  effect: BookingCompletionEffect,
  run: (entries: CreatedEntry[], transaction: TxScope) => Promise<void>,
): Promise<boolean> => {
  if (context.plan.facts.flow === "balance") {
    return runBookingDbEffect(context, effect, () => Promise.resolve());
  }
  const entries = await context.entries();
  return runBookingDbEffect(context, effect, (transaction) =>
    run(entries, transaction),
  );
};

export const bookingCompletionActions: BookingCompletionActions = {
  answers: (context) =>
    runRegistrationDbEffect(context, "answers", (entries, transaction) =>
      saveSessionAnswers(entries, context.plan.input, transaction),
    ),
  balance_activity: (context) =>
    runBookingDbEffect(context, "balance_activity", async (transaction) => {
      if (context.plan.facts.flow === "balance") {
        await logCompletionActivity(
          context.current,
          `Reservation balance paid: ${formatCurrency(requiredFirst(context.plan.input.items, "booking item").p)}`,
          context.plan.facts.listingId,
          transaction,
        );
      }
    }),
  external_deliveries: (context) => deliverNextPaidCompletion(context.current),
  external_delivery_setup: async (context) => {
    const deliveries =
      context.plan.facts.flow === "registration"
        ? await preparePaidCompletionDeliveries(
            context.current,
            await context.entries(),
            context.plan.input.siteTokenIndex,
          )
        : [];
    return runBookingDbEffect(
      context,
      "external_delivery_setup",
      (transaction) =>
        storePaymentCompletionDeliveries(
          transaction,
          context.current.payment.id,
          deliveries,
        ),
    );
  },
  promo_activity: (context) =>
    runRegistrationDbEffect(
      context,
      "promo_activity",
      async (entries, transaction) => {
        const first = requiredFirst(entries, "registration entry");
        for (const promo of context.plan.facts.promos) {
          const value =
            promo.delta < 0
              ? `${formatCurrency(-promo.delta)} off`
              : `+${formatCurrency(promo.delta)}`;
          await logActivity(
            `Promo code '${promo.name}' used: ${value}`,
            first.listing,
            first.attendee.id,
            transaction,
          );
        }
      },
    ),
  registration_activity: (context) =>
    runRegistrationDbEffect(
      context,
      "registration_activity",
      logRegistrationActivities,
    ),
};

const bookingSuccess = (
  current: CompletionCurrent,
  _plan: BookingCompletion,
): BookingSuccess => {
  const result = paymentCompletionResult(current.payment);
  if (!result.success) {
    throw new Error(`Payment ${current.payment.id} has no booking result`);
  }
  return result;
};

/** Resume successful booking effects. Each external destination has its own
 * durable row and one row is attempted per invocation. */
export const completePaidBooking: CompletionHandler<
  BookingCompletionActions,
  BookingSuccess
> = definePaymentCompletion({
  actions: bookingCompletionActions,
  criticalEffects: [],
  effects: BookingCompletionEffectSchema.options,
  finish: async (current, plan) => {
    await finishCompletion(current, plan, "completed");
    return bookingSuccess(current, plan);
  },
  label: "booking",
  matches: (completion): completion is BookingCompletion =>
    completion.kind === "booking",
  prepare: completionEntries,
  result: bookingSuccess,
  run: async (effect, current, plan, entries, actions) => {
    const completed = await actions[effect]({ current, entries, plan });
    return completed
      ? completedStep(current)
      : {
          current,
          kind: "paused",
          nextReconcileAt: Date.now(),
          result: bookingSuccess(current, plan),
        };
  },
});
