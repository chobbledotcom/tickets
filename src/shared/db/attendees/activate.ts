import { insertManyStatement } from "#shared/accounting/rows.ts";
import { assertPostable } from "#shared/accounting/store.ts";
import type { CanonicalBooking } from "#shared/booking-lines.ts";
import type { AttendeeInput } from "#shared/db/attendee-types.ts";
import {
  type ActivationFailure,
  findStageProblem,
  refusalReason,
} from "#shared/db/attendees/activation-refusal.ts";
import {
  bookingCapacityFields,
  currentBatchCapacityCondition,
} from "#shared/db/attendees/capacity/checks.ts";
import { bookingStartAt } from "#shared/db/attendees/capacity/range.ts";
import {
  bookingWriteGuard,
  type FinalizedBookingBatchPlan,
  isBookingWriteGuardFailure,
  isRequiredColumnFailure,
} from "#shared/db/attendees/create-batch.ts";
import { annotateOrderParents } from "#shared/db/attendees/order-parents.ts";
import {
  attendeeEncryptionInput,
  encryptAttendeeFields,
} from "#shared/db/attendees/pii.ts";
import {
  andConditions,
  executeBatchWithResults,
  type SqlStatement,
  update,
} from "#shared/db/client.ts";
import {
  allModifiersInStockCondition,
  usageBatchInsert,
} from "#shared/db/modifier-usage.ts";
import { batchFinalizeStatement } from "#shared/db/payment-finalize.ts";
import { UNRESOLVED_RESERVATION } from "#shared/db/processed-payments.ts";
import { nowIso } from "#shared/now.ts";

type ActivationLine = {
  listingId: number;
  packageGroupId: number;
  parentListingId: number;
  quantity: number;
  startAt: string | null;
};

const activationLines = (bookings: CanonicalBooking[]): ActivationLine[] =>
  bookings.map((booking) => ({
    listingId: booking.listingId,
    packageGroupId: booking.packageGroupId ?? 0,
    parentListingId: booking.parentListingId ?? 0,
    quantity: booking.quantity,
    startAt: bookingStartAt(booking),
  }));

const expectedLineMatch = (
  bookingAlias: string,
  expectedAlias: string,
): string =>
  `${bookingAlias}.listing_id = json_extract(${expectedAlias}.value, '$.listingId')
   AND ${bookingAlias}.start_at IS json_extract(${expectedAlias}.value, '$.startAt')
   AND ${bookingAlias}.parent_listing_id = json_extract(${expectedAlias}.value, '$.parentListingId')
   AND ${bookingAlias}.package_group_id = json_extract(${expectedAlias}.value, '$.packageGroupId')`;

/** The staged rows must still be exactly the signed order. Count plus one match
 * per expected slot is complete because booking slots are unique. */
const stagedLinesCondition = (
  attendeeId: number,
  linesJson: string,
  lineCount: number,
): SqlStatement => ({
  args: [attendeeId, lineCount, linesJson, attendeeId],
  sql: `(SELECT COUNT(*) FROM listing_attendees AS booking
          WHERE booking.attendee_id = ?) = ?
        AND NOT EXISTS (
          SELECT 1 FROM json_each(?) AS expected
           WHERE NOT EXISTS (
             SELECT 1 FROM listing_attendees AS booking
              WHERE booking.attendee_id = ? AND booking.quantity = 0
                AND ${expectedLineMatch("booking", "expected")}
           )
        )`,
});

/** Claim the right to activate without changing state yet. Capacity, modifier
 * stock, and stage shape are one verdict under the batch's write lock. Stage and
 * payment ownership are established by the preceding guarded statements. */
const activationVerdict = (
  sessionId: string,
  attendeeId: number,
  linesJson: string,
  lineCount: number,
  capacity: SqlStatement,
  plan: FinalizedBookingBatchPlan,
): SqlStatement => {
  const allowed = andConditions([
    stagedLinesCondition(attendeeId, linesJson, lineCount),
    capacity,
    allModifiersInStockCondition(plan.usages),
  ]);
  return {
    args: [sessionId, attendeeId, ...allowed.args],
    sql: `UPDATE checkout_stages SET state = state
           WHERE payment_session_id = ? AND attendee_id = ? AND state = 'pending'
             AND ${allowed.sql}`,
  };
};

/** Turn all staged rows live in one statement. The preceding verdict established
 * the exact row set and holds the write lock until this batch commits. */
const activateLinesStatement = (
  attendeeId: number,
  linesJson: string,
): SqlStatement => ({
  args: [linesJson, attendeeId],
  sql: `WITH expected AS (SELECT value FROM json_each(?))
        UPDATE listing_attendees AS booking
           SET quantity = (
             SELECT CAST(json_extract(expected.value, '$.quantity') AS INTEGER)
               FROM expected
              WHERE ${expectedLineMatch("booking", "expected")}
           )
         WHERE booking.attendee_id = ? AND booking.quantity = 0
           AND EXISTS (
             SELECT 1 FROM expected
              WHERE ${expectedLineMatch("booking", "expected")}
           )`,
});

/** Abort the batch if payment finalization did not affect its one reserved row.
 * A separate constraint signature keeps this invariant failure distinct from a
 * refused activation verdict. */
const paymentFinalizeGuard = (sessionId: string): SqlStatement => ({
  args: [`${sessionId}:activation-finalize-guard`],
  sql: `INSERT INTO processed_payments (payment_session_id, processed_at)
        SELECT ?, NULL WHERE changes() != 1`,
});

/** Establish this exact pending stage as the batch's activation target. */
const stageOwnershipStatement = (
  sessionId: string,
  attendeeId: number,
): SqlStatement => ({
  args: [sessionId, attendeeId],
  sql: `UPDATE checkout_stages SET state = state
         WHERE payment_session_id = ? AND attendee_id = ? AND state = 'pending'`,
});

/** Abort when the stage ownership statement did not match exactly one row. */
const stageOwnershipGuard = (sessionId: string): SqlStatement => ({
  args: [`${sessionId}:activation-stage-guard`],
  sql: `INSERT INTO checkout_stages
          (payment_session_id, attendee_id, provider, ticket_tokens, state, created_at)
        SELECT ?, NULL, '', '', '', '' WHERE changes() != 1`,
});

/** Establish the unresolved processed-payment claim under the same write lock. */
const paymentOwnershipStatement = (sessionId: string): SqlStatement => ({
  args: [sessionId],
  sql: `UPDATE processed_payments SET processed_at = processed_at
         WHERE payment_session_id = ? AND ${UNRESOLVED_RESERVATION}`,
});

const isPaymentFinalizeGuardFailure = isRequiredColumnFailure(
  "processed_payments.processed_at",
);

const isStageOwnershipGuardFailure = isRequiredColumnFailure(
  "checkout_stages.attendee_id",
);

/** Claim every staged booking row and complete its money state in one fixed-size
 * batch. A missed capacity or modifier guard rolls everything back. */
export const activateStagedBooking = async (
  sessionId: string,
  attendeeId: number,
  ticketToken: string,
  input: Omit<AttendeeInput, "bookings" | "paymentId"> & {
    bookings: CanonicalBooking[];
    paymentId: string;
  },
  plan: FinalizedBookingBatchPlan,
): Promise<
  { success: true } | { reason: ActivationFailure; success: false }
> => {
  const bookings = await annotateOrderParents(input.bookings);
  const stageProblem = await findStageProblem(attendeeId, bookings);
  if (stageProblem) return { reason: stageProblem, success: false };
  const capacity = await currentBatchCapacityCondition(
    bookings.map((booking) => ({
      date: booking.date,
      ...bookingCapacityFields(booking),
    })),
    undefined,
    { primary: true },
  );
  if (!capacity) return { reason: "capacity_exceeded", success: false };
  const encryptionInput = attendeeEncryptionInput(
    { ...input, bookings },
    input.paymentId,
  );
  const enc = await encryptAttendeeFields(encryptionInput, ticketToken);
  if (!enc) throw new Error("Could not encrypt staged attendee");
  assertPostable(plan.legs);
  const linesJson = JSON.stringify(activationLines(bookings));
  const piiUpdate = update(
    "attendees",
    { pii_blob: enc.encryptedPiiBlob },
    { id: attendeeId },
  );
  const finalize = await batchFinalizeStatement(
    sessionId,
    "?",
    attendeeId,
    { args: [], sql: "1 = 1" },
    plan.finalize.paymentReference,
    ticketToken,
  );
  const statements: SqlStatement[] = [
    stageOwnershipStatement(sessionId, attendeeId),
    stageOwnershipGuard(sessionId),
    paymentOwnershipStatement(sessionId),
    paymentFinalizeGuard(sessionId),
    activationVerdict(
      sessionId,
      attendeeId,
      linesJson,
      bookings.length,
      capacity,
      plan,
    ),
    bookingWriteGuard(),
    piiUpdate,
    activateLinesStatement(attendeeId, linesJson),
    ...(plan.usages.length > 0
      ? [usageBatchInsert(plan.usages, attendeeId)]
      : []),
    ...(plan.legs.length > 0
      ? [
          insertManyStatement(plan.legs, nowIso()),
          {
            args: [plan.legs[0]!.eventGroup, attendeeId],
            sql: `UPDATE listing_attendees SET ledger_event_group = ?
                   WHERE attendee_id = ?`,
          },
        ]
      : []),
    finalize,
    paymentFinalizeGuard(sessionId),
    {
      args: [sessionId, attendeeId],
      sql: `UPDATE checkout_stages SET state = 'booked', ticket_tokens = ''
             WHERE payment_session_id = ? AND attendee_id = ? AND state = 'pending'`,
    },
  ];

  try {
    await executeBatchWithResults(statements);
    return { success: true };
  } catch (error) {
    if (isPaymentFinalizeGuardFailure(error)) {
      throw new Error(`Payment session ${sessionId} was not finalized`);
    }
    if (isStageOwnershipGuardFailure(error)) {
      throw new Error(
        `Checkout stage for session ${sessionId} was not this attendee's pending stage at activation (attendee ${attendeeId})`,
      );
    }
    if (!isBookingWriteGuardFailure(error)) throw error;
    return {
      reason: await refusalReason(attendeeId, bookings, plan.usages),
      success: false,
    };
  }
};
