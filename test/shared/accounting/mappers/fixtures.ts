/** Shared fixtures for the accounting mappers' tests. */

import { expect } from "@std/expect";
import type { BookingFacts } from "#accounting/mappers.ts";
import type { Transfer, TransferInput } from "#shared/ledger/types.ts";

// balanceOf ignores id, so a constant id keeps these as plain value assertions.
export const asTransfer = (t: TransferInput): Transfer => ({
  ...t,
  id: 0,
  recordedAt: "2026-06-21T00:00:00.000Z",
});

export const facts = (overrides: Partial<BookingFacts> = {}): BookingFacts => ({
  amountPaid: 0,
  attendeeId: 3,
  bookingFee: 0,
  eventId: "evt",
  lines: [],
  modifiers: [],
  occurredAt: "2026-06-21T00:00:00.000Z",
  ...overrides,
});

/** The canonical "paid booking that nets to zero" fixture: 5000 + 3000 gross,
 *  −500 discount + 200 surcharge + 150 booking fee, paid at 7850. Used by the
 *  `mapBooking` net-zero test (booking legs) and `mapRefund` reversal test
 *  (refund legs must zero every account back out), so both share the exact
 *  same booking facts rather than re-spelling them. */
export const paidBookingNettingToZero: Partial<BookingFacts> = {
  amountPaid: 7850,
  bookingFee: 150,
  lines: [
    { gross: 5000, listingId: 1 },
    { gross: 3000, listingId: 2 },
  ],
  modifiers: [
    { delta: -500, modifierId: 10 }, // discount
    { delta: 200, modifierId: 11 }, // surcharge
  ],
};

/** The one leg of this kind, refusing a missing or duplicated collection
 * before the caller reads its fields. */
export const soleLegOf = (
  kind: string,
): ((legs: readonly TransferInput[]) => Transfer) => {
  const pick = (legs: readonly TransferInput[]): Transfer => {
    const matched = legs.filter((leg) => leg.kind === kind);
    expect(matched.length).toBe(1);
    return asTransfer(matched[0]!);
  };
  return pick;
};
