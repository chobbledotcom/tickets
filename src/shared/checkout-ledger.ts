/**
 * Bridge from a priced checkout to the ledger's {@link BookingFacts}.
 *
 * Kept pure (no clock, no I/O): the caller supplies the attendee id, currency,
 * business time, and a stable per-order id. This is where checkout pricing meets
 * the ledger, so the accounting layer stays free of the pricing types.
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

/** The per-order facts the pure pricing can't supply (id, clock, currency). */
export type BookingLedgerContext = {
  readonly attendeeId: number;
  readonly currency: string;
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
  currency: ctx.currency,
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
