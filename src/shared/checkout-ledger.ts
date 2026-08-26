/**
 * Where checkout pricing meets the ledger, so the accounting layer stays free
 * of the pricing types. Pure: the caller supplies the clock.
 *
 * `gross` is the full list price, not the amount charged now. Modifiers post
 * their own legs and a deposit leaves the rest owed, so revenue is recognised
 * gross at sale.
 *
 * Lines are summed BY LISTING, so a listing bought through two paths posts one
 * combined sale leg. The per-row readback splits it by quantity, which averages
 * the rows when the paths priced differently.
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
 * For a booking where NOTHING was collected and NO booking fee is charged. The
 * customer simply OWES the order.
 *
 * The gross `lines` and `modifierApplications` survive, because a surcharge
 * add-on is still owed. Everything else is dropped and the total forced to
 * zero, so no `fee` and no `payment` leg post.
 *
 * This closes the hole where a configured booking fee was recorded as phantom
 * booking-fee income plus phantom external cash.
 */
export const owedOrderForLedger = (order: PricedOrder): PricedOrder => ({
  ...order,
  extras: [],
  total: 0,
});
