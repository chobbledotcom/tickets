/**
 * Atomic booking-ledger posting shared by the paid and free checkout paths.
 *
 * Both the provider-webhook (paid) flow and the zero-total (free) flow build a
 * {@link LedgerPoster} here and hand it to `createAttendeeAtomic`, so a booking,
 * its consumed modifier stock, and its sale/payment legs commit or roll back as
 * one. Keeping the poster in one place is what lets a fully-discounted or
 * zero-deposit free booking record exactly the same ledger facts a paid one
 * does — the two paths differ only in where the currency, business time, and
 * event id come from.
 */

import { ledgerTx } from "#shared/accounting/ledger-tx.ts";
import { mapBooking } from "#shared/accounting/mappers.ts";
import {
  bookingFactsFromOrder,
  owedOrderForLedger,
} from "#shared/checkout-ledger.ts";
import type { PricedOrder } from "#shared/checkout-pricing.ts";
import type {
  AttendeeInput,
  CreateAttendeeResult,
} from "#shared/db/attendee-types.ts";
import type { LedgerPoster } from "#shared/db/attendees/create.ts";
import {
  type BookingBatchPlan,
  createAttendeeAtomic,
  reconcileLedgerBalanceTx,
} from "#shared/db/attendees.ts";
import type { TxScope } from "#shared/db/client.ts";
import {
  consumeModifierStockTx,
  type ModifierUsage,
} from "#shared/db/modifier-usage.ts";
import { nowIso } from "#shared/now.ts";

/** Thrown from the create transaction when a stock-limited modifier sold out
 *  between pricing and consumption, rolling the whole booking (and any ledger
 *  legs) back so the caller surfaces the sold-out error / refunds. Shared by the
 *  paid and free paths so both roll back the same way. */
export class ModifierSoldOutError extends Error {}

/**
 * The per-order facts the ledger needs that the pure priced order can't supply.
 * `eventId` is derived from the attendee id once the insert assigns it: the paid
 * path keys on its payment session id (ignoring the argument), the free path on
 * the attendee id, since it has no session.
 */
export type BookingLedger = {
  readonly pricedOrder: PricedOrder;
  readonly occurredAt: string;
  readonly eventId: (attendeeId: number) => string;
};

/**
 * A {@link LedgerPoster} that, inside the attendee-create transaction, consumes
 * the order's modifier stock and — when `ledger` is given — posts the booking's
 * ledger legs. Pass `ledger: null` to consume stock without touching the ledger:
 * with payments disabled a booking collects nothing, so there is no money to
 * record, but a stock-limited tier must still be capped.
 *
 * Throws {@link ModifierSoldOutError} the moment a modifier is sold out, which
 * rolls the create back: no attendee, no stock, no legs.
 */
export const bookingLedgerPoster =
  (usages: ModifierUsage[], ledger: BookingLedger | null): LedgerPoster =>
  async (tx, attendeeId) => {
    if (!(await consumeModifierStockTx(tx, attendeeId, usages))) {
      throw new ModifierSoldOutError();
    }
    if (ledger) {
      const legs = await mapBooking(
        bookingFactsFromOrder(ledger.pricedOrder, {
          attendeeId,
          eventId: ledger.eventId(attendeeId),
          occurredAt: ledger.occurredAt,
        }),
      );
      await postBookingLegsTx(tx, attendeeId, legs);
    }
  };

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
 * on `eventId`), and — for a paid session — the session to finalize in the same
 * batch. The paid path keys `eventId` on its payment session id, so the legs are
 * attendee-id-independent and can be built before the attendee exists. */
export const bookingBatchPlan = async (
  usages: ModifierUsage[],
  ledger: { pricedOrder: PricedOrder; occurredAt: string; eventId: string },
  finalizeSessionId?: string,
): Promise<BookingBatchPlan> => ({
  finalizeSessionId,
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
    await tx.execute({
      args: [legs[0]!.eventGroup, attendeeId],
      sql: "UPDATE listing_attendees SET ledger_event_group = ? WHERE attendee_id = ?",
    });
  }
};

/**
 * The {@link LedgerPoster} for an admin manual attendee add. The add form
 * captures per-listing quantities (so each line's GROSS is its listing price ×
 * quantity) and one order-level outstanding balance, but no amount-paid field —
 * so this records the same shape of legs a real booking does with nothing
 * collected: the gross `sale` legs (recognising income, exactly the live path's
 * {@link owedOrderForLedger}) and NO `payment`/`fee` leg, then reconciles the
 * attendee's owed balance to the operator-entered `remainingBalance`.
 *
 * Both steps run in the create transaction `tx` (the attendee, its sale legs and
 * its balance reconcile commit or roll back together). The reconcile recomputes
 * its delta from the freshly-read in-tx balance, so it is the difference between
 * the gross just posted and what the operator says is still owed — modelling the
 * already-paid portion as a `writeoff` adjustment (never phantom external cash),
 * leaving the attendee owing exactly `remainingBalance`. A zero-gross add (free
 * listings) still owes exactly `remainingBalance`.
 */
export const manualAddLedgerPoster =
  (order: PricedOrder, remainingBalance: number): LedgerPoster =>
  async (tx, attendeeId) => {
    const legs = await mapBooking(
      bookingFactsFromOrder(owedOrderForLedger(order), {
        attendeeId,
        eventId: String(attendeeId),
        occurredAt: nowIso(),
      }),
    );
    await postBookingLegsTx(tx, attendeeId, legs);
    await reconcileLedgerBalanceTx(tx, attendeeId, remainingBalance);
  };

/**
 * Create an attendee whose ledger poster may throw {@link ModifierSoldOutError},
 * returning the literal `"sold-out"` instead of throwing so each checkout path
 * renders its own response — the paid path refunds, the free path re-shows the
 * form. Any other error propagates. Shared so both paths translate a sold-out
 * race the same way, and so the in-transaction rollback (no attendee, no stock,
 * no legs) lives in one place.
 *
 * Omit `postLedger` when there are no legs to post and no stock to consume: the
 * create then runs as a single batch rather than an interactive transaction, so
 * concurrent provider-less bookings don't contend on the one connection (an
 * empty interactive transaction would still serialise them and can fail to
 * commit while another is mid-flight).
 */
export const createOrSoldOut = (
  input: AttendeeInput,
  postLedger?: LedgerPoster,
): Promise<CreateAttendeeResult | "sold-out"> =>
  createAttendeeAtomic(input, postLedger).catch((error: unknown) => {
    if (error instanceof ModifierSoldOutError) return "sold-out" as const;
    throw error;
  });
