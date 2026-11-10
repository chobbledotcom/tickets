// effects: pure
/**
 * The plan of a subscription ticket: how often Stripe charges, how much, and
 * the VAT inside each charge. The listing states the price a new subscriber
 * gets. A booking row keeps the plan Stripe reported when that person
 * subscribed, so a later listing edit never reaches them.
 */

import { Temporal } from "temporal-polyfill";
import * as v from "valibot";
import { assessTax } from "#shared/tax/assessment.ts";
import type { TaxPolicy } from "#shared/tax/types.ts";

export const RecurringIntervalSchema = v.picklist(["week", "month", "year"]);
export type RecurringInterval = v.InferOutput<typeof RecurringIntervalSchema>;
/** A listing's frequency: an interval, or blank for an ordinary ticket. */
export const RecurringIntervalChoiceSchema = v.union([
  v.literal(""),
  RecurringIntervalSchema,
]);
export type RecurringIntervalChoice = v.InferOutput<
  typeof RecurringIntervalChoiceSchema
>;

const PERIOD_OF: Record<RecurringInterval, Temporal.DurationLike> = {
  month: { months: 1 },
  week: { weeks: 1 },
  year: { years: 1 },
};

/** When Stripe first charges the recurring price, as unix seconds: one period
 * after the first payment. */
export const firstRecurringChargeAt = (
  nowSeconds: number,
  interval: RecurringInterval,
): number =>
  Temporal.Instant.fromEpochMilliseconds(nowSeconds * 1000)
    .toZonedDateTimeISO("UTC")
    .add(PERIOD_OF[interval])
    .toInstant().epochMilliseconds / 1000;

/** Every status Stripe gives a subscription. */
export const SubscriptionStatusSchema = v.picklist([
  "active",
  "canceled",
  "incomplete",
  "incomplete_expired",
  "past_due",
  "paused",
  "trialing",
  "unpaid",
]);
export type SubscriptionStatus = v.InferOutput<typeof SubscriptionStatusSchema>;

/** What Stripe reported about the subscription a checkout started. `amount`
 * is the charge each period for the whole quantity, VAT included. */
export type SubscriptionStart = {
  amount: number;
  id: string;
  interval: RecurringInterval;
  listingId: number;
  status: SubscriptionStatus;
};

/** The plan one booking row keeps. `amount` is what Stripe charges each
 * period for the whole quantity, VAT included. */
export type SubscriptionPlan = {
  amount: number;
  id: string;
  interval: RecurringInterval;
  status: SubscriptionStatus;
  tax: number;
};

/** What the listing asks Stripe to charge each period for this quantity:
 * the recurring price, plus VAT when the site adds VAT to its prices. */
export const recurringCharge = (
  listing: { id: number; recurringPrice: number },
  quantity: number,
  policy: TaxPolicy,
): number =>
  assessTax(
    {
      lines: [{ gross: listing.recurringPrice * quantity, listingId: listing.id }],
      modifiers: [],
    },
    policy,
  ).total;

/** The plan a booking row keeps for a subscription Stripe started, with the
 * VAT inside each payment at the rate frozen at checkout. */
export const planOfStart = (
  start: SubscriptionStart,
  policy: TaxPolicy,
): SubscriptionPlan => ({
  amount: start.amount,
  id: start.id,
  interval: start.interval,
  status: start.status,
  tax: vatInRecurringPayment(start.listingId, start.amount, policy),
});

/**
 * The VAT inside one recurring payment. The amount always includes its VAT,
 * so the VAT is the fraction of the amount at the frozen rate. For a site that
 * adds VAT, this recovers exactly the VAT that {@link recurringCharge} added.
 */
export const vatInRecurringPayment = (
  listingId: number,
  amount: number,
  policy: TaxPolicy,
): number => {
  if (policy.mode === "none") return 0;
  return assessTax(
    { lines: [{ gross: amount, listingId }], modifiers: [] },
    { mode: "calculate_from_total", rateBasisPoints: policy.rateBasisPoints },
  ).taxAmount;
};
