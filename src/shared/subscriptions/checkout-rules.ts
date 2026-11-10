/** The orders a subscription checkout can take. */

import { t } from "#i18n";
import type { CheckoutIntent, CheckoutItem } from "#shared/payments.ts";
import type { PaymentProviderType } from "#types";

export type SubscriptionItem = CheckoutItem & {
  recurring: NonNullable<CheckoutItem["recurring"]>;
};

const isSubscriptionItem = (item: CheckoutItem): item is SubscriptionItem =>
  item.recurring !== undefined;

/** The one subscription line of an order, or null for an ordinary order. */
export const subscriptionItemOrNull = (
  intent: CheckoutIntent,
): SubscriptionItem | null => intent.items.find(isSubscriptionItem) ?? null;

/**
 * Why the order cannot start a subscription, or null when it can. Stripe is
 * the only provider that charges again for this site. One booking row keeps
 * the plan, so the order holds one subscription line, booked on its own. A
 * package, an add-on, a deposit and a balance cannot carry it.
 */
export const subscriptionCheckoutError = (
  provider: PaymentProviderType,
  intent: CheckoutIntent,
): string | null => {
  const items = intent.items.filter(isSubscriptionItem);
  const [item] = items;
  if (item === undefined) return null;
  if (provider !== "stripe")
    return t("payment.error.subscription_needs_stripe");
  const childIds = new Set(
    (intent.allocations ?? []).map((allocation) => allocation.childId),
  );
  const sharedLine =
    items.length > 1 ||
    item.packageGroupId !== undefined ||
    childIds.has(item.listingId);
  if (sharedLine) return t("payment.error.subscription_on_its_own");
  const partPayment =
    intent.reservationAmount !== undefined ||
    intent.balanceAttendeeId !== undefined;
  return partPayment ? t("payment.error.subscription_no_deposit") : null;
};
