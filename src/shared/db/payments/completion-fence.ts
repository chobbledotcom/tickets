import {
  queryOne,
  resultRows,
  type SqlStatement,
  type TxScope,
} from "#shared/db/client.ts";

export class PendingPaymentCompletionError extends Error {
  constructor() {
    super("Cannot delete data used by pending payment completion");
    this.name = "PendingPaymentCompletionError";
  }
}

const pendingCompletionStatement =
  (join: string, field: string) =>
  (id: number): SqlStatement => ({
    args: [id],
    sql: `SELECT paymentSession.id
            FROM payment_sessions AS paymentSession
            ${join}
           WHERE ${field} = ?
             AND paymentSession.completion_state = 'pending'
           LIMIT 1`,
  });

const pendingAttendeeStatement = pendingCompletionStatement(
  "",
  "paymentSession.attendee_id",
);
const pendingListingStatement = pendingCompletionStatement(
  `JOIN listing_attendees AS listingAttendee
     ON listingAttendee.attendee_id = paymentSession.attendee_id`,
  "listingAttendee.listing_id",
);

const rowExists = async (statement: SqlStatement): Promise<boolean> =>
  (await queryOne<{ id: string }>(statement.sql, statement.args)) !== null;

export const attendeeHasPendingPaymentCompletion = (
  attendeeId: number,
): Promise<boolean> => rowExists(pendingAttendeeStatement(attendeeId));

export const listingHasPendingPaymentCompletion = (
  listingId: number,
): Promise<boolean> => rowExists(pendingListingStatement(listingId));

const requireNoPendingCompletion = async (
  transaction: TxScope,
  statement: SqlStatement,
): Promise<void> => {
  if (resultRows(await transaction.execute(statement)).length > 0) {
    throw new PendingPaymentCompletionError();
  }
};

export const requireNoPendingAttendeePaymentCompletion = (
  transaction: TxScope,
  attendeeId: number,
): Promise<void> =>
  requireNoPendingCompletion(transaction, pendingAttendeeStatement(attendeeId));

export const requireNoPendingListingPaymentCompletion = (
  transaction: TxScope,
  listingId: number,
): Promise<void> =>
  requireNoPendingCompletion(transaction, pendingListingStatement(listingId));
