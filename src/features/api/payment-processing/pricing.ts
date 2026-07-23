/**
 * Turn validated items into a checkout intent, re-price it, and decide whether a
 * trusted session's *current* prices still match what was charged — the last
 * gate before a signed order is honoured. A mismatch here (a listing, modifier,
 * or answer price edited between checkout and now) yields a {@link RefundSpec},
 * so the booking is stored and refunded rather than completed.
 */

import { sumOf } from "#fp";
import type { ValidatedItem } from "#routes/api/payment-processing/package-pricing.ts";
import {
  type RefundSpec,
  refundSpec,
} from "#routes/api/payment-processing/refunds.ts";
import type { BookingIntent } from "#routes/api/webhook-types.ts";
import { calculateBookingFee } from "#shared/booking-fee.ts";
import type { PricedOrder } from "#shared/checkout-pricing.ts";
import { contactFields } from "#shared/db/attendees/pii.ts";
import type {
  CheckoutIntent,
  CheckoutItem,
  ModifierSpec,
} from "#shared/payments.ts";
import type { ListingWithCount } from "#shared/types.ts";

/** Check if the amount charged matches the current listing price (including booking fee).
 * For pay-more listings, the amount must be >= the expected minimum price and <= the max cap.
 * `quantity` scales max_price so purchases are validated against the correct total cap. */
const hasPriceMismatch = (
  amountTotal: number,
  expectedPrice: number,
  listing: Pick<ListingWithCount, "can_pay_more" | "max_price">,
  bookingFeePercent: number,
  quantity: number,
): boolean => {
  if (listing.can_pay_more) {
    const minWithFee =
      expectedPrice + calculateBookingFee(expectedPrice, bookingFeePercent);
    const maxTicketTotal = listing.max_price * quantity;
    const maxWithFee =
      maxTicketTotal + calculateBookingFee(maxTicketTotal, bookingFeePercent);
    return amountTotal < minWithFee || amountTotal > maxWithFee;
  }
  const expectedWithFee =
    expectedPrice + calculateBookingFee(expectedPrice, bookingFeePercent);
  return amountTotal !== expectedWithFee;
};

export const checkoutIntentForSession = (
  intent: BookingIntent,
  validatedItems: ValidatedItem[],
  modifierSpecs: ModifierSpec[],
): CheckoutIntent => ({
  ...contactFields(intent),
  date: intent.date,
  items: validatedItems.map((v) => ({
    listingId: v.item.e,
    name: v.listing.name,
    ...(v.item.k === "p" && v.item.r !== undefined
      ? { packageGroupId: v.item.r }
      : {}),
    quantity: v.item.q,
    slug: v.listing.slug,
    unitPrice: v.item.p / v.item.q,
  })),
  modifiers: modifierSpecs,
  ...(intent.dayCount ? { dayCount: intent.dayCount } : {}),
  ...(intent.reservationAmount
    ? { reservationAmount: intent.reservationAmount }
    : {}),
});

export const orderLineTotal = (order: PricedOrder): number =>
  sumOf(
    (line: PricedOrder["lines"][number]) =>
      line.chargedUnitAmount * line.quantity,
  )(order.lines);

/** Each intent item's charged total, keyed by the item OBJECT (a listing
 * booked through two paths is two items, each with its own amount). */
export const paidByItem = (order: PricedOrder): Map<CheckoutItem, number> => {
  const paid = new Map<CheckoutItem, number>();
  for (const line of order.lines) {
    const current = paid.get(line.item) ?? 0;
    paid.set(line.item, current + line.chargedUnitAmount * line.quantity);
  }
  return paid;
};

/**
 * The pricing refund reason for a trusted session, or null when its prices still
 * match — computed WITHOUT refunding, so the booking is stored first and the
 * refund happens together with the ledger reversal and note.
 *
 * `agreed` is the signed total. The proof already pins every pricing input
 * (items, modifier refs, answer ids, reservation snapshot) and the charge equals
 * `agreed`, so the only thing that can still differ is the *current* database
 * price — a listing/modifier/answer price edited between checkout and now. Both
 * checks catch that legitimate mid-checkout price change. Pricing-code divergence
 * on identical inputs is caught at dev time by the property-based consistency
 * test, so this path refunds without paging.
 */
export const paidPricingRefund = (
  validatedItems: ValidatedItem[],
  pricedOrder: PricedOrder,
  agreed: number,
): RefundSpec | null => {
  // Fail closed first: a `null` expected price means a package line is no longer
  // a valid member (package deleted/unflagged or the listing removed). This is
  // checked for every item regardless of price, so even a free package member
  // refunds rather than completing.
  for (const { listing, expectedPrice } of validatedItems) {
    if (expectedPrice === null) {
      return refundSpec("price_changed")(
        `Package member listing ${listing.id} is no longer part of its package`,
      );
    }
  }
  // Per-item prices are ticket-only (no fee), so validate without booking fee.
  // EVERY item is checked, not just the ones signed paid: a package override (or
  // base price) raised from 0 to positive while an add-on/modifier kept the order
  // paid would otherwise slip through, because `pricedOrder` is re-derived from
  // the signed zero unit prices so the total still matches `agreed` — only this
  // comparison against the freshly loaded `expectedPrice` sees the drift. A
  // genuinely free line (signed 0, still 0) costs nothing here: it never
  // mismatches. expectedPrice is non-null by the fail-closed loop above.
  for (const { item, listing, expectedPrice } of validatedItems) {
    if (hasPriceMismatch(item.p, expectedPrice!, listing, 0, item.q)) {
      return refundSpec("price_changed")(
        `Per-item price mismatch for listing ${listing.id}: metadata p=${item.p} but expected ${expectedPrice} (can_pay_more=${listing.can_pay_more})`,
      );
    }
  }
  if (pricedOrder.total !== agreed) {
    return refundSpec("price_changed")(
      `Re-derived total ${pricedOrder.total} differs from signed total ${agreed}`,
    );
  }
  return null;
};
