import { bookingLegBatchInsert } from "#shared/accounting/rows.ts";
import { assertPostable } from "#shared/accounting/store.ts";
import type { EncryptedAttendeeData } from "#shared/db/attendee-types.ts";
import {
  executeBatchWithResults,
  inPlaceholders,
  type SqlStatement,
  type TxScope,
  withTransaction,
} from "#shared/db/client.ts";
import {
  allModifiersInStockCondition,
  type ModifierUsage,
  usageInsert,
} from "#shared/db/modifier-usage.ts";
import { batchFinalizeStatement } from "#shared/db/payment-finalize.ts";
import type { TransferInput } from "#shared/ledger/types.ts";
import { nowIso } from "#shared/now.ts";

export type PreparedWrite = {
  enc: EncryptedAttendeeData;
  attendeeInsert: SqlStatement;
  bookingStatements: SqlStatement[];
};

export type WriteOutcome = {
  insertId: number | bigint | undefined;
};

/** Posts ledger legs inside the attendee transaction when a caller cannot
 * prepare the whole operation as a batch. */
export type LedgerPoster = (tx: TxScope, attendeeId: number) => Promise<void>;

export type BookingBatchPlan = {
  usages: ModifierUsage[];
  legs: TransferInput[];
  finalize: { paymentReference: string; sessionId: string } | null;
};

export type FinalizedBookingBatchPlan = Omit<BookingBatchPlan, "finalize"> & {
  finalize: { paymentReference: string; sessionId: string };
};

/** The new attendee id inside a batch. last_insert_rowid() cannot be used after
 * later inserts, while ticket_token_index uniquely identifies this row. */
export const ATTENDEE_BY_TOKEN_SQL =
  "(SELECT MAX(id) FROM attendees WHERE ticket_token_index = ?)";

/** Abort a whole libsql batch when the preceding guarded booking did not land.
 * The deliberate NOT NULL failure rolls the transaction back; no compensating
 * delete is needed and no partial attendee becomes visible. */
const BOOKING_WRITE_GUARD: SqlStatement = {
  args: [],
  sql: `INSERT INTO listing_attendees (listing_id, attendee_id, quantity)
        SELECT NULL, NULL, 1 WHERE changes() = 0`,
};

const MODIFIER_WRITE_GUARD: SqlStatement = {
  args: [],
  sql: `INSERT INTO modifier_usages
          (modifier_id, attendee_id, quantity, amount_applied, created)
        SELECT NULL, NULL, 1, 0, '' WHERE changes() = 0`,
};

const isBookingWriteGuard = (error: unknown): boolean =>
  error instanceof Error &&
  error.message.includes(
    "NOT NULL constraint failed: listing_attendees.listing_id",
  );

const guardedBookingStatements = (
  bookingStatements: SqlStatement[],
): SqlStatement[] =>
  bookingStatements.flatMap((statement) => [statement, BOOKING_WRITE_GUARD]);

const runAtomicBatch = async (
  prepared: PreparedWrite,
  leading: SqlStatement[] = [],
  trailing: SqlStatement[] = [],
): Promise<WriteOutcome | null> => {
  try {
    const results = await executeBatchWithResults([
      prepared.attendeeInsert,
      ...leading,
      ...guardedBookingStatements(prepared.bookingStatements),
      ...trailing,
      {
        args: [prepared.enc.ticketTokenIndex],
        sql: "SELECT id FROM attendees WHERE ticket_token_index = ?",
      },
    ]);
    const attendeeResult = results[results.length - 1]!;
    return {
      insertId: Number(attendeeResult.rows[0]!.id),
    };
  } catch (error) {
    if (isBookingWriteGuard(error)) return null;
    throw error;
  }
};

class IncompleteBooking extends Error {}

/** Create an attendee and run a callback in one interactive transaction. */
export const writeWithLedger = (
  prepared: PreparedWrite,
  postLedger: LedgerPoster,
): Promise<WriteOutcome | null> =>
  withTransaction<WriteOutcome>(async (tx) => {
    const insertId = (await tx.execute(prepared.attendeeInsert))
      .lastInsertRowid;
    for (const statement of prepared.bookingStatements) {
      if ((await tx.execute(statement)).rowsAffected === 0) {
        throw new IncompleteBooking();
      }
    }
    await postLedger(tx, Number(insertId));
    return { insertId };
  }).catch((error) => {
    if (error instanceof IncompleteBooking) return null;
    throw error;
  });

/** Create an attendee and all booking rows, rolling the transaction back when
 * any requested row cannot land. */
export const writeAsBatch = (
  prepared: PreparedWrite,
): Promise<WriteOutcome | null> => runAtomicBatch(prepared);

class ModifierStockFailure extends Error {}

export const isModifierStockFailure = (
  error: unknown,
): error is ModifierStockFailure => error instanceof ModifierStockFailure;

const andConditions = (conditions: SqlStatement[]): SqlStatement => ({
  args: conditions.flatMap((condition) => condition.args),
  sql: conditions.map((condition) => `(${condition.sql})`).join(" AND "),
});

const noExistingLedgerCondition = (legs: TransferInput[]): SqlStatement => {
  if (legs.length === 0) return { args: [], sql: "1 = 1" };
  const eventGroup = legs[0]!.eventGroup;
  const references = legs.map((leg) => leg.reference);
  return {
    args: [eventGroup, ...references],
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

/** Create the booking, consume modifier stock, post ledger legs, and optionally
 * finalize its payment in one transaction. */
export const writeAsLedgerBatch = async (
  prepared: PreparedWrite,
  plan: BookingBatchPlan,
): Promise<WriteOutcome | null> => {
  assertPostable(plan.legs);
  const recordedAt = nowIso();
  const tokenIndex = prepared.enc.ticketTokenIndex;
  const always = { args: [], sql: "1 = 1" };
  const modifierCondition = allModifiersInStockCondition(plan.usages);
  const modifierCheckStatements: SqlStatement[] =
    plan.usages.length > 0
      ? [
          {
            args: [tokenIndex, ...modifierCondition.args],
            sql: `UPDATE attendees SET id = id
                WHERE ticket_token_index = ? AND ${modifierCondition.sql}`,
          },
          MODIFIER_WRITE_GUARD,
        ]
      : [];
  const usageStatements = plan.usages.map((usage) =>
    usageInsert(usage, ATTENDEE_BY_TOKEN_SQL, [tokenIndex], always),
  );
  const legStatements = plan.legs.map((leg) =>
    bookingLegBatchInsert(
      leg,
      recordedAt,
      ATTENDEE_BY_TOKEN_SQL,
      tokenIndex,
      always,
    ),
  );
  const eventGroupStatements: SqlStatement[] =
    plan.legs.length > 0
      ? [
          {
            args: [plan.legs[0]!.eventGroup, tokenIndex],
            sql: `UPDATE listing_attendees SET ledger_event_group = ?
              WHERE attendee_id = ${ATTENDEE_BY_TOKEN_SQL}`,
          },
        ]
      : [];
  const finalizeStatements: SqlStatement[] = plan.finalize
    ? [
        await batchFinalizeStatement(
          plan.finalize.sessionId,
          ATTENDEE_BY_TOKEN_SQL,
          tokenIndex,
          always,
          plan.finalize.paymentReference,
          prepared.enc.ticketToken,
        ),
      ]
    : [];
  try {
    return await runAtomicBatch(prepared, modifierCheckStatements, [
      ...usageStatements,
      ...legStatements,
      ...eventGroupStatements,
      ...finalizeStatements,
    ]);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes(
        "NOT NULL constraint failed: modifier_usages.modifier_id",
      )
    ) {
      throw new ModifierStockFailure();
    }
    throw error;
  }
};
