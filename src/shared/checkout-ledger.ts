/**
 * Bridge from a priced checkout to the ledger's {@link BookingFacts}.
 *
 * Kept pure (no clock, no I/O): the caller supplies the attendee id, business
 * time, and a stable per-order id. This is where checkout pricing meets the
 * ledger, so the accounting layer stays free of the pricing types.
 *
 * `gross` is each listing's full list price (`unitPrice × quantity`), not the
 * amount charged now: modifiers post as their own legs and a deposit leaves the
 * rest owed on the attendee account, so revenue is recognised gross at sale.
 * `amountPaid` is the cash actually taken now (`order.total` — a deposit or the
 * full amount).
 */

import type { BookingFacts } from "#shared/accounting/mappers.ts";
import {
  lineListPrice,
  lineTotalsByListingId,
  type PricedOrder,
} from "#shared/checkout-pricing.ts";

/** The per-order facts the pure pricing can't supply (id, clock). */
export type BookingLedgerContext = {
  readonly attendeeId: number;
  readonly occurredAt: string;
  readonly eventId: string;
};

export const bookingFactsFromOrder = (
  order: PricedOrder,
  ctx: BookingLedgerContext,
): BookingFacts => ({
  amountPaid: order.total,
  attendeeId: ctx.attendeeId,
  bookingFee: order.extras.find((extra) => extra.key === "fee")?.amount ?? 0,
  eventId: ctx.eventId,
  lines: [...lineTotalsByListingId(order.lines, lineListPrice)].map(
    ([listingId, gross]) => ({ gross, listingId }),
  ),
  modifiers: order.modifierApplications.map((application) => ({
    delta: application.delta,
    modifierId: application.modifierId,
  })),
  occurredAt: ctx.occurredAt,
});

/**
 * Recast a priced order into the ledger order for a booking where NOTHING was
 * collected and NO booking fee is charged — the customer simply OWES the order.
 * Used by the provider-less public booking (payments disabled, so no provider
 * took a deposit and — per the owner's rule — payments-off charges no booking
 * fee) and the admin manual add (no amount-paid field, so nothing is recorded as
 * paid up front).
 *
 * It keeps the gross ticket `lines` (each line's `lineListPrice` is its full
 * `unitPrice × quantity`, untouched by the zeroed charge) and the
 * `modifierApplications` (a surcharge add-on is still owed, posted as its own
 * `modifier` leg), but drops every extra and forces the total to zero. Through
 * {@link bookingFactsFromOrder} that yields `bookingFee: 0` (no `fee` leg) and
 * `amountPaid: 0` (no `payment` leg), while the gross `sale`/owed legs leave the
 * full ticket price owed on the attendee account. Doing it here — rather than
 * relying on `reservationAmount: "0"` alone — closes the hole where a configured
 * booking fee (and, with a surcharge add-on, a fee even after `feeSubtotal: 0`)
 * was recorded as phantom booking-fee income plus phantom external cash.
 */
export const owedOrderForLedger = (order: PricedOrder): PricedOrder => ({
  ...order,
  extras: [],
  total: 0,
});
