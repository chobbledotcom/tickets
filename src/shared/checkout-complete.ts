/**
 * Booking-ledger helpers shared by the paid and free checkout paths.
 *
 * The live paid (provider-webhook) and free (zero-total) flows both commit a
 * booking, its consumed modifier stock, and its sale/payment legs as ONE libsql
 * batch via {@link bookingBatchPlan} + `createBookingAtomic`, so a
 * fully-discounted or zero-deposit free booking records exactly the same ledger
 * facts a paid one does — the two paths differ only in where the currency,
 * business time, and event id come from. The admin manual-add still posts inside
 * its create transaction via {@link manualAddLedgerPoster}.
 */

import { ledgerTx } from "#shared/accounting/ledger-tx.ts";
import { mapBooking } from "#shared/accounting/mappers.ts";
import {
  bookingFactsFromOrder,
  owedOrderForLedger,
} from "#shared/checkout-ledger.ts";
import type { PricedOrder } from "#shared/checkout-pricing.ts";
import type {
  BookingBatchPlan,
  LedgerPoster,
} from "#shared/db/attendees/create.ts";
import type { SqlStatement } from "#shared/db/client.ts";
import { type TxScope, update } from "#shared/db/client.ts";
import type { ModifierUsage } from "#shared/db/modifier-usage.ts";
import { nowIso } from "#shared/now.ts";

/**
 * The attendee id stitched into the booking facts when building legs for the
 * single-batch path. The legs' references and event group are derived from the
 * payment session id (see mapBooking), never the attendee id, so any valid
 * placeholder yields the correct keys; the real id is spliced into each leg's
 * account by an in-batch subquery at write time. */
const BATCH_LEG_ATTENDEE_PLACEHOLDER = 1;

/**
 * Build the {@link BookingBatchPlan} for the single-batch checkout: the modifier
 * stock to consume, the booking's ledger legs (sale/modifier/fee/payment, keyed
 * on `eventId`), and — for a paid session — the session/reference to finalize in
 * the same batch. The paid path keys `eventId` on its payment session id, so the
 * legs are attendee-id-independent and can be built before the attendee exists. */
export const bookingBatchPlan = async (
  usages: ModifierUsage[],
  ledger: { pricedOrder: PricedOrder; occurredAt: string; eventId: string },
  finalize?: SqlStatement[],
): Promise<BookingBatchPlan> => ({
  ...(finalize !== undefined ? { finalize } : {}),
  legs: await mapBooking(
    bookingFactsFromOrder(ledger.pricedOrder, {
      attendeeId: BATCH_LEG_ATTENDEE_PLACEHOLDER,
      eventId: ledger.eventId,
      occurredAt: ledger.occurredAt,
    }),
  ),
  usages,
});

/**
 * Post a booking's ledger legs inside the create transaction and stamp the
 * order's `listing_attendees` rows with its event group, so the per-row
 * amount-paid (and the attendee's outstanding-balance) projection resolves
 * exactly this booking's legs. A fully-free order posts no legs and leaves
 * `ledger_event_group` '' (its money projects to 0). Shared by every booking
 * poster — the paid/free checkout and the provider-less owed booking.
 */
export const postBookingLegsTx = async (
  tx: TxScope,
  attendeeId: number,
  legs: Awaited<ReturnType<typeof mapBooking>>,
): Promise<void> => {
  await ledgerTx.post(tx, legs);
  if (legs.length > 0) {
    await tx.execute(
      update(
        "listing_attendees",
        { ledger_event_group: legs[0]!.eventGroup },
        { attendee_id: attendeeId },
      ),
    );
  }
};

/**
 * The {@link LedgerPoster} for an admin manual attendee add. The add form
 * captures per-listing quantities (so each line's GROSS is its listing price ×
 * quantity) but no amount-paid or outstanding-balance field — so this records
 * the same shape of legs a real booking does with nothing collected: the gross
 * `sale` legs (recognising income, exactly the live path's
 * {@link owedOrderForLedger}) and NO `payment`/`fee` leg. The attendee is left
 * owing the full gross; an operator records any already-paid portion afterwards
 * through the ledger (an auditable `writeoff`/`payment` correction), so the form
 * never sets a balance. A zero-gross add (free listings) owes nothing.
 */
export const manualAddLedgerPoster =
  (order: PricedOrder): LedgerPoster =>
  async (tx, attendeeId) => {
    const legs = await mapBooking(
      bookingFactsFromOrder(owedOrderForLedger(order), {
        attendeeId,
        eventId: String(attendeeId),
        occurredAt: nowIso(),
      }),
    );
    await postBookingLegsTx(tx, attendeeId, legs);
  };
