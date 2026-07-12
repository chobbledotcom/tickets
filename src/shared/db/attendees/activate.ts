import type { InValue } from "@libsql/client";
import { assertPostable } from "#shared/accounting/store.ts";
import type { OrderBooking } from "#shared/booking-lines.ts";
import { postBookingLegsTx } from "#shared/checkout-complete.ts";
import type { AttendeeInput } from "#shared/db/attendee-types.ts";
import {
  lineKeyFromBooking,
  loadExistingLines,
} from "#shared/db/attendees/atomic-update.ts";
import { bookingSlotKey } from "#shared/db/attendees/booking-slot.ts";
import {
  bookingStartAt,
  dateToStartEnd,
} from "#shared/db/attendees/capacity.ts";
import type { FinalizedBookingBatchPlan } from "#shared/db/attendees/create-batch.ts";
import {
  attendeeEncryptionInput,
  encryptAttendeeFields,
} from "#shared/db/attendees/pii.ts";
import { buildCapacityCondition } from "#shared/db/capacity.ts";
import { type SqlStatement, withTransaction } from "#shared/db/client.ts";
import {
  allModifiersInStockCondition,
  anyModifierSoldOut,
  usageInsert,
} from "#shared/db/modifier-usage.ts";
import { batchFinalizeStatement } from "#shared/db/payment-finalize.ts";

export type ActivationFailure = "capacity_exceeded" | "sold-out";

class ActivationRefused extends Error {}

const expectedLineKey = (booking: OrderBooking): string =>
  bookingSlotKey(
    booking.listingId,
    bookingStartAt(booking),
    booking.parentListingId,
    booking.packageGroupId,
  );

const assertStageMatches = async (
  attendeeId: number,
  bookings: OrderBooking[],
): Promise<void> => {
  const existing = await loadExistingLines(attendeeId);
  const expected = bookings.map(expectedLineKey).toSorted();
  const actual = existing
    .map(({ booking }) => {
      if (booking.quantity !== 0) {
        throw new Error(`Checkout stage ${attendeeId} is already active`);
      }
      return lineKeyFromBooking(booking);
    })
    .toSorted();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Checkout stage ${attendeeId} booking lines changed`);
  }
};

const activationStatement = (
  attendeeId: number,
  booking: OrderBooking,
  modifierCondition: SqlStatement,
): SqlStatement => {
  const date = booking.date;
  const durationDays = booking.durationDays;
  const parentListingId =
    booking.parentListingId === undefined ? 0 : booking.parentListingId;
  const packageGroupId =
    booking.packageGroupId === undefined ? 0 : booking.packageGroupId;
  const { startAt, endAt } = dateToStartEnd(date, durationDays);
  const capacity = buildCapacityCondition(
    booking.listingId,
    booking.quantity,
    date,
    undefined,
    durationDays,
  );
  const args: InValue[] = [
    booking.quantity,
    startAt,
    endAt,
    attendeeId,
    booking.listingId,
    startAt,
    parentListingId,
    packageGroupId,
    ...capacity.args,
    ...modifierCondition.args,
  ];
  return {
    args,
    sql: `UPDATE listing_attendees
          SET quantity = ?, start_at = ?, end_at = ?
          WHERE attendee_id = ? AND listing_id = ? AND start_at IS ?
            AND parent_listing_id = ? AND package_group_id = ?
            AND (${capacity.sql}) AND (${modifierCondition.sql})`,
  };
};

/** Claim every staged booking row and complete its money state in one
 * transaction. A missed capacity or modifier guard rolls everything back. */
export const activateStagedBooking = async (
  sessionId: string,
  attendeeId: number,
  ticketToken: string,
  input: Omit<AttendeeInput, "bookings" | "paymentId"> & {
    bookings: OrderBooking[];
    paymentId: string;
  },
  plan: FinalizedBookingBatchPlan,
): Promise<
  { success: true } | { reason: ActivationFailure; success: false }
> => {
  await assertStageMatches(attendeeId, input.bookings);
  const encryptionInput = attendeeEncryptionInput(input, input.paymentId);
  const enc = await encryptAttendeeFields(encryptionInput, ticketToken);
  if (!enc) throw new Error("Could not encrypt staged attendee");
  const finalize = plan.finalize;
  assertPostable(plan.legs);
  const modifierCondition = allModifiersInStockCondition(plan.usages);

  try {
    await withTransaction(async (tx) => {
      await tx.execute({
        args: [enc.encryptedPiiBlob, attendeeId],
        sql: "UPDATE attendees SET pii_blob = ? WHERE id = ?",
      });
      for (const booking of input.bookings) {
        const result = await tx.execute(
          activationStatement(attendeeId, booking, modifierCondition),
        );
        if (result.rowsAffected !== 1) throw new ActivationRefused();
      }
      for (const usage of plan.usages) {
        await tx.execute(
          usageInsert(usage, "?", [attendeeId], { args: [], sql: "1 = 1" }),
        );
      }
      await postBookingLegsTx(tx, attendeeId, plan.legs);
      const finalized = await tx.execute(
        await batchFinalizeStatement(
          sessionId,
          "?",
          attendeeId,
          { args: [], sql: "1 = 1" },
          finalize.paymentReference,
          ticketToken,
        ),
      );
      if (finalized.rowsAffected !== 1) {
        throw new Error(`Payment session ${sessionId} was not finalized`);
      }
      await tx.execute({
        args: [sessionId],
        sql: "UPDATE checkout_stages SET state = 'booked' WHERE payment_session_id = ?",
      });
    });
    return { success: true };
  } catch (error) {
    if (!(error instanceof ActivationRefused)) throw error;
    return (await anyModifierSoldOut(plan.usages))
      ? { reason: "sold-out", success: false }
      : { reason: "capacity_exceeded", success: false };
  }
};
