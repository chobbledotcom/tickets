// effects: pure
/** What a Stripe subscription read tells a completed checkout. */

import type { SubscriptionStart } from "#shared/subscriptions/plan.ts";
import { parsePositiveInt } from "#shared/validation/number.ts";
import type { StripeInvoicePayments, StripeSubscription } from "./schemas.ts";

/** The payment intent that paid the first invoice. Refunds and charge reads
 * of the first payment use it, as they use the intent of a one-off checkout.
 * An unpaid invoice names none, and the paid checkout then refuses the blank
 * reference. */
const firstPaymentIntent = (invoice: StripeInvoicePayments): string =>
  invoice.payments.data.find(
    (entry) =>
      entry.status === "paid" && entry.payment.type === "payment_intent",
  )?.payment.payment_intent ?? "";

/** The listing whose booking row keeps the plan. The checkout wrote it, so a
 * subscription without it is not one of ours. */
const subscribedListingId = (subscription: StripeSubscription): number => {
  const listingId = parsePositiveInt(subscription.metadata.listing_id ?? "");
  if (listingId === null) {
    throw new Error(
      `Stripe subscription ${subscription.id} names no listing in its metadata`,
    );
  }
  return listingId;
};

/** The plan the checkout started, and the intent that paid `firstInvoice`,
 * the invoice of the checkout itself. */
export const subscriptionStartOf = (
  subscription: StripeSubscription,
  firstInvoice: StripeInvoicePayments,
): { paymentReference: string; start: SubscriptionStart } => {
  const [item] = subscription.items.data;
  return {
    paymentReference: firstPaymentIntent(firstInvoice),
    start: {
      amount: item.price.unit_amount * item.quantity,
      id: subscription.id,
      interval: item.price.recurring.interval,
      listingId: subscribedListingId(subscription),
      status: subscription.status,
    },
  };
};
