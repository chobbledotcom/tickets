import { bookingLegBatchInsert } from "#shared/accounting/rows.ts";
import { assertPostable } from "#shared/accounting/store.ts";
import type { EncryptedAttendeeData } from "#shared/db/attendee-types.ts";
import {
  type PendingCheckoutStage,
  pendingCheckoutStageInsert,
} from "#shared/db/checkout-stages.ts";
import {
  andConditions,
  executeBatchWithResults,
  inPlaceholders,
  resultRows,
  type SqlStatement,
  type TxScope,
  withTransaction,
} from "#shared/db/client.ts";
import {
  allModifiersInStockCondition,
  type ModifierUsage,
  usageInsert,
} from "#shared/db/modifier-usage.ts";
import { batchFinalizeStatements } from "#shared/db/payment-finalize.ts";
import type { TransferInput } from "#shared/ledger/types.ts";
import { namedError } from "#shared/named-error.ts";
import { nowIso } from "#shared/now.ts";

export type PreparedWrite = {
  enc: EncryptedAttendeeData;
  attendeeInsert: SqlStatement;
  bookingStatements: SqlStatement[];
  activityStatements: SqlStatement[];
};

export type WriteOutcome = { insertId: number };

export type LedgerPoster = (tx: TxScope, attendeeId: number) => Promise<void>;

export type BookingBatchPlan = {
  usages: ModifierUsage[];
  legs: TransferInput[];
  finalize?: { paymentReference: string; sessionId: string };
};

/** The newly inserted attendee is always found by its unique stable token. */
export const ATTENDEE_BY_TOKEN_SQL =
  "(SELECT id FROM attendees WHERE ticket_token_index = ?)";

/** Abort the batch if the immediately preceding guarded booking did not insert
 * exactly one row. The deliberate NOT NULL failure rolls back every write. */
const bookingWriteGuard = (): SqlStatement => ({
  args: [1],
  sql: `INSERT INTO listing_attendees (listing_id, attendee_id, quantity)
        SELECT NULL, NULL, 1 WHERE changes() != ?`,
});

const isRequiredColumnFailure =
  (column: string) =>
  (error: unknown): boolean =>
    error instanceof Error &&
    error.message.includes(`NOT NULL constraint failed: ${column}`);

const isBookingWriteGuardFailure = isRequiredColumnFailure(
  "listing_attendees.listing_id",
);

const guardedBookings = (statements: SqlStatement[]): SqlStatement[] =>
  statements.flatMap((statement) => [statement, bookingWriteGuard()]);

const attendeeIdStatement = (tokenIndex: string): SqlStatement => ({
  args: [tokenIndex],
  sql: "SELECT id FROM attendees WHERE ticket_token_index = ?",
});

const runAtomicBatch = async (
  prepared: PreparedWrite,
  trailing: SqlStatement[] = [],
): Promise<WriteOutcome | null> => {
  try {
    const results = await executeBatchWithResults([
      prepared.attendeeInsert,
      ...guardedBookings(prepared.bookingStatements),
      ...trailing,
      ...prepared.activityStatements,
      attendeeIdStatement(prepared.enc.ticketTokenIndex),
    ]);
    const rows = resultRows<{ id: number }>(results[results.length - 1]!);
    return { insertId: Number(rows[0]!.id) };
  } catch (error) {
    if (isBookingWriteGuardFailure(error)) return null;
    throw error;
  }
};

class IncompleteBooking extends namedError("IncompleteBooking") {}

/** Create an attendee, all bookings, caller work, and contact activity in one
 * interactive transaction. */
export const writeWithLedger = (
  prepared: PreparedWrite,
  postLedger: LedgerPoster,
): Promise<WriteOutcome | null> =>
  withTransaction<WriteOutcome>(async (tx) => {
    await tx.execute(prepared.attendeeInsert);
    for (const statement of prepared.bookingStatements) {
      if ((await tx.execute(statement)).rowsAffected !== 1) {
        throw new IncompleteBooking();
      }
    }
    const attendeeRows = resultRows<{ id: number }>(
      await tx.execute(attendeeIdStatement(prepared.enc.ticketTokenIndex)),
    );
    const attendeeId = Number(attendeeRows[0]!.id);
    await postLedger(tx, attendeeId);
    for (const statement of prepared.activityStatements) {
      await tx.execute(statement);
    }
    return { insertId: attendeeId };
  }).catch((error) => {
    if (error instanceof IncompleteBooking) return null;
    throw error;
  });

export const writeAsBatch = (
  prepared: PreparedWrite,
): Promise<WriteOutcome | null> => runAtomicBatch(prepared);

/** Create the attendee, zero-quantity booking identities, and pending checkout
 * stage in one batch. */
export const writeAsCheckoutStageBatch = async (
  prepared: PreparedWrite,
  stage: PendingCheckoutStage,
): Promise<WriteOutcome | null> =>
  runAtomicBatch(prepared, [
    await pendingCheckoutStageInsert(
      stage,
      ATTENDEE_BY_TOKEN_SQL,
      [prepared.enc.ticketTokenIndex],
      prepared.enc.ticketToken,
    ),
  ]);

const noExistingLedgerCondition = (legs: TransferInput[]): SqlStatement => {
  if (legs.length === 0) return { args: [], sql: "1 = 1" };
  const references = legs.map((leg) => leg.reference);
  return {
    args: [legs[0]!.eventGroup, ...references],
    sql: `NOT EXISTS (SELECT 1 FROM transfers WHERE event_group = ?)
          AND NOT EXISTS (SELECT 1 FROM transfers WHERE reference IN (${inPlaceholders(
            references,
          )}))`,
  };
};

export const bookingBatchCondition = (plan: BookingBatchPlan): SqlStatement =>
  andConditions([
    allModifiersInStockCondition(plan.usages),
    noExistingLedgerCondition(plan.legs),
  ]);

/** Create the attendee, all bookings, modifiers, ledger, contact activity, and
 * optional payment finalization in one transaction. */
export const writeAsLedgerBatch = async (
  prepared: PreparedWrite,
  plan: BookingBatchPlan,
): Promise<WriteOutcome | null> => {
  assertPostable(plan.legs);
  const tokenIndex = prepared.enc.ticketTokenIndex;
  const always = { args: [], sql: "1 = 1" };
  const recordedAt = nowIso();
  const usages = plan.usages.map((usage) =>
    usageInsert(usage, ATTENDEE_BY_TOKEN_SQL, [tokenIndex], always),
  );
  const legs = plan.legs.map((leg) =>
    bookingLegBatchInsert(
      leg,
      recordedAt,
      ATTENDEE_BY_TOKEN_SQL,
      tokenIndex,
      always,
    ),
  );
  const eventGroup: SqlStatement[] =
    plan.legs.length === 0
      ? []
      : [
          {
            args: [plan.legs[0]!.eventGroup, tokenIndex],
            sql: `UPDATE listing_attendees SET ledger_event_group = ?
                  WHERE attendee_id = ${ATTENDEE_BY_TOKEN_SQL}`,
          },
        ];
  const finalize = plan.finalize
    ? await batchFinalizeStatements(
        plan.finalize.sessionId,
        ATTENDEE_BY_TOKEN_SQL,
        tokenIndex,
        plan.finalize.paymentReference,
        prepared.enc.ticketToken,
      )
    : [];
  return runAtomicBatch(prepared, [
    ...usages,
    ...legs,
    ...eventGroup,
    ...finalize,
  ]);
};
