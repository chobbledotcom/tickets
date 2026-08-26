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
 * `amountPaid` is the cash actually taken now.
 *
 * Lines are summed BY LISTING, so a listing bought through two paths in one
 * order posts one combined sale leg. The per-row readback then splits it by
 * quantity, which averages the rows when the paths priced differently.
 */

import type { BookingFacts } from "#accounting/mappers.ts";
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
 * collected and NO booking fee is charged. The customer simply OWES the order.
 * Two callers use it. The provider-less public booking charges no booking fee
 * when payments are disabled, per the owner's rule. The admin manual add has no
 * amount-paid field, so nothing is recorded as paid up front.
 *
 * It keeps the gross ticket `lines` and the `modifierApplications` (a surcharge
 * add-on is still owed, posted as its own `modifier` leg), but drops every extra
 * and forces the total to zero. Through {@link bookingFactsFromOrder} that
 * yields `bookingFee: 0` (no `fee` leg) and `amountPaid: 0` (no `payment` leg),
 * while the gross `sale`/owed legs leave the full ticket price owed on the
 * attendee account. This step closes the hole where a configured booking fee
 * was recorded as phantom booking-fee income plus phantom external cash.
 */
export const owedOrderForLedger = (order: PricedOrder): PricedOrder => ({
  ...order,
  extras: [],
  total: 0,
});
