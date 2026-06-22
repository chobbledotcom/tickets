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

import { mapBooking } from "#shared/accounting/mappers.ts";
import { postTransfersTx } from "#shared/accounting/store.ts";
import { bookingFactsFromOrder } from "#shared/checkout-ledger.ts";
import type { PricedOrder } from "#shared/checkout-pricing.ts";
import type {
  AttendeeInput,
  CreateAttendeeResult,
} from "#shared/db/attendee-types.ts";
import type { LedgerPoster } from "#shared/db/attendees/create.ts";
import { createAttendeeAtomic } from "#shared/db/attendees.ts";
import {
  consumeModifierStockTx,
  type ModifierUsage,
} from "#shared/db/modifier-usage.ts";

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
  readonly currency: string;
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
      await postTransfersTx(
        tx,
        await mapBooking(
          bookingFactsFromOrder(ledger.pricedOrder, {
            attendeeId,
            currency: ledger.currency,
            eventId: ledger.eventId(attendeeId),
            occurredAt: ledger.occurredAt,
          }),
        ),
      );
    }
  };

/**
 * Create an attendee whose ledger poster may throw {@link ModifierSoldOutError},
 * returning the literal `"sold-out"` instead of throwing so each checkout path
 * renders its own response — the paid path refunds, the free path re-shows the
 * form. Any other error propagates. Shared so both paths translate a sold-out
 * race the same way, and so the in-transaction rollback (no attendee, no stock,
 * no legs) lives in one place.
 */
export const createOrSoldOut = (
  input: AttendeeInput,
  postLedger: LedgerPoster,
): Promise<CreateAttendeeResult | "sold-out"> =>
  createAttendeeAtomic(input, postLedger).catch((error: unknown) => {
    if (error instanceof ModifierSoldOutError) return "sold-out" as const;
    throw error;
  });
