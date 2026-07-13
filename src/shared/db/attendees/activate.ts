import type { InValue } from "@libsql/client";
import { assertPostable } from "#shared/accounting/store.ts";
import type { OrderBooking } from "#shared/booking-lines.ts";
import { postBookingLegsTx } from "#shared/checkout-complete.ts";
import type { AttendeeInput } from "#shared/db/attendee-types.ts";
import {
  type ActivationFailure,
  findStageProblem,
  refusalReason,
} from "#shared/db/attendees/activation-refusal.ts";
import { dateToStartEnd } from "#shared/db/attendees/capacity.ts";
import type { FinalizedBookingBatchPlan } from "#shared/db/attendees/create-batch.ts";
import { annotateOrderParents } from "#shared/db/attendees/order-parents.ts";
import {
  attendeeEncryptionInput,
  encryptAttendeeFields,
} from "#shared/db/attendees/pii.ts";
import { buildCapacityCondition } from "#shared/db/capacity.ts";
import {
  type SqlStatement,
  update,
  withTransaction,
} from "#shared/db/client.ts";
import {
  allModifiersInStockCondition,
  usageInsert,
} from "#shared/db/modifier-usage.ts";
import { batchFinalizeStatement } from "#shared/db/payment-finalize.ts";

class ActivationRefused extends Error {}

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
            AND quantity = 0
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
  // Staging wrote its rows through the same parent-tagging pass (an order that
  // books a child beside its parent gets the pairing stamped on). Run it here
  // too, so both sides derive their line keys from one pipeline — otherwise a
  // parent+child order would always read as "changed" and be refunded. An edge
  // added or removed since staging still reads as a genuine change below.
  const bookings = await annotateOrderParents(input.bookings);
  const stageProblem = await findStageProblem(attendeeId, bookings);
  if (stageProblem) return { reason: stageProblem, success: false };
  const encryptionInput = attendeeEncryptionInput(
    { ...input, bookings },
    input.paymentId,
  );
  const enc = await encryptAttendeeFields(encryptionInput, ticketToken);
  if (!enc) throw new Error("Could not encrypt staged attendee");
  const finalize = plan.finalize;
  assertPostable(plan.legs);
  const modifierCondition = allModifiersInStockCondition(plan.usages);
  const piiUpdate = update(
    "attendees",
    { pii_blob: enc.encryptedPiiBlob },
    { id: attendeeId },
  );

  try {
    await withTransaction(async (tx) => {
      await tx.execute(piiUpdate);
      for (const booking of bookings) {
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
    // The claim's own `quantity = 0` condition makes the stage-active check
    // atomic with the write: a row flipped live (or changed) in the gap since
    // the pre-check misses the UPDATE and lands here. refusalReason re-checks
    // the rows before blaming stock, so a stage problem never classifies as a
    // refundable capacity failure.
    return {
      reason: await refusalReason(attendeeId, bookings, plan.usages),
      success: false,
    };
  }
};
