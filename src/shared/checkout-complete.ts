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

/* jscpd:ignore-start */
import { attendeeAccount, WORLD, WRITEOFF } from "#accounting/accounts.ts";
import { KIND } from "#accounting/kinds.ts";
import { ledgerTx } from "#accounting/ledger-tx.ts";
import {
  MANUAL_ATTENDEE_CHARGE,
  MANUAL_ATTENDEE_WRITEOFF,
} from "#accounting/manual-entries.ts";
import { bookingEventGroup, mapBooking } from "#accounting/mappers.ts";
import { legReference, type RefPart } from "#accounting/refs.ts";
import { encrypt } from "#crypto/encryption.ts";
import type {
  AttendeeCreationWork,
  BookingBatchPlan,
} from "#db/attendees/create.ts";
import { type TxScope, update } from "#db/client.ts";
import type { ModifierUsage } from "#db/modifier-usage.ts";
import type { TaggedPaymentReference } from "#payment/provider-reference.ts";
import {
  type BookingLedgerContext,
  bookingFactsFromOrder,
  owedOrderForLedger,
} from "#shared/checkout-ledger.ts";
import type { PricedOrder } from "#shared/checkout-pricing.ts";
import type { AccountRef, TransferInput } from "#shared/ledger/types.ts";
import { nowIso } from "#shared/now.ts";

/* jscpd:ignore-end */

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
  finalize?: {
    paymentReference: TaggedPaymentReference | null;
    sessionId: string;
  },
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
    // Fill only rows still missing their order's link, so the stamp stays
    // per ORDER: a row this order never created (an earlier order's line, a
    // merge-moved row) keeps the group it was stamped with.
    await tx.execute(
      update(
        "listing_attendees",
        { ledger_event_group: legs[0]!.eventGroup },
        { attendee_id: attendeeId, ledger_event_group: "" },
      ),
    );
  }
};

/**
 * The creation work for an admin manual attendee add. The add form
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
  (order: PricedOrder): AttendeeCreationWork =>
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

/** One named one-off amount an API create records. `amount` is signed minor
 * units: positive bills the attendee (a charge), negative forgives part of the
 * debt (a writeoff). `description` is the label the Ledger tab shows. */
export type CreateAdjustment = {
  amount: number;
  description: string;
};

/** The money an API create records beyond the priced lines: payments already
 * received, and named one-off adjustments. */
export type CreateReceipts = {
  adjustments: CreateAdjustment[];
  payments: number[];
};

/** One API-create leg (a payment or an adjustment) sharing the booking event
 * group. A distinct per-leg reference keeps each independent for refunds and
 * display. */
const apiCreateLeg = async (
  ctx: BookingLedgerContext,
  group: string,
  refParts: RefPart[],
  leg: {
    amount: number;
    destination: AccountRef;
    kind: string;
    memo?: string | undefined;
    source: AccountRef;
  },
): Promise<TransferInput> => {
  const { memo, ...rest } = leg;
  return {
    ...rest,
    ...(memo === undefined ? {} : { memo }),
    eventGroup: group,
    occurredAt: ctx.occurredAt,
    reference: await legReference(refParts),
  };
};

/** One adjustment leg, in the exact shape a manual attendee charge or writeoff
 * posts. The WRITEOFF contra sits on the far side. The manual entry kind makes
 * the order total count a charge, and the Ledger tab labels it. The operator's
 * description is free text, so it is owner-key encrypted before the `memo`
 * column stores it. */
const adjustmentLeg = async (
  attendee: AccountRef,
  adjustment: CreateAdjustment,
  index: number,
  ctx: BookingLedgerContext,
  group: string,
): Promise<TransferInput> => {
  const charge = adjustment.amount > 0;
  return apiCreateLeg(ctx, group, ["api-adjustment", ctx.eventId, index], {
    amount: Math.abs(adjustment.amount),
    destination: charge ? WRITEOFF : attendee,
    kind: charge ? MANUAL_ATTENDEE_CHARGE : MANUAL_ATTENDEE_WRITEOFF,
    memo: await encrypt(adjustment.description),
    source: charge ? attendee : WRITEOFF,
  });
};

/**
 * The creation work for an API attendee create. Unlike the manual-add form,
 * the create body can carry a per-line price override, payments already
 * received, and named adjustments. The poster records every leg of the money
 * at creation. It posts the gross `sale` legs at the lines' prices. It posts
 * one `payment` leg per received payment. It posts the charge/writeoff contra
 * legs. All legs share one event group, so a refund that reads the posted legs
 * back reverses every one of them exactly.
 */
export const apiCreateLedgerPoster =
  (order: PricedOrder, receipts: CreateReceipts): AttendeeCreationWork =>
  async (tx, attendeeId) => {
    const ctx: BookingLedgerContext = {
      attendeeId,
      eventId: String(attendeeId),
      occurredAt: nowIso(),
    };
    const legs = await mapBooking(
      bookingFactsFromOrder(owedOrderForLedger(order), ctx),
    );
    const group = await bookingEventGroup(ctx.eventId);
    const attendee = attendeeAccount(attendeeId);
    await postBookingLegsTx(tx, attendeeId, [
      ...legs,
      // One payment leg per received payment: cash from the world into the
      // attendee.
      ...(await Promise.all(
        receipts.payments.map((amount, index) =>
          apiCreateLeg(ctx, group, ["api-payment", ctx.eventId, index], {
            amount,
            destination: attendee,
            kind: KIND.payment,
            source: WORLD,
          }),
        ),
      )),
      ...(await Promise.all(
        receipts.adjustments.map((adjustment, index) =>
          adjustmentLeg(attendee, adjustment, index, ctx, group),
        ),
      )),
    ]);
  };
