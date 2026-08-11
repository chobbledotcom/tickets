/**
 * Reading, rewriting, and letting go of the rows a refund run holds. Taking
 * the all-or-none hold lives in `payment-claim/take.ts`.
 */

/* jscpd:ignore-start -- imports */
import type { InValue } from "@libsql/client";
import { mapNotNullish } from "#fp";
import { decrypt, encrypt } from "#shared/crypto/encryption.ts";
import type { EnvKeyEncrypted } from "#shared/crypto/sealed.ts";
import {
  executeBatch,
  inPlaceholders,
  queryBatchPrimary,
  resultRows,
  type SqlStatement,
  type TxScope,
} from "#shared/db/client.ts";
import { nowIso } from "#shared/now.ts";
import { mirrorFor } from "#shared/payment/admit-move.ts";
import {
  EMPTY_ROW_STATE,
  isEmptyRowState,
  type PaymentRowState,
  readRowState,
  writeRowState,
} from "#shared/payment/row-state.ts";

/* jscpd:ignore-end */

const SLOT = "processed_payments.failure_data";

/** One row as the reading transaction found it. The stored slot is kept exactly
 *  as read, because every write back is conditioned on it being unchanged. */
export type PaymentRowRecord = {
  readonly attendeeId: number;
  readonly sessionId: string;
  readonly slot: string;
  readonly state: PaymentRowState;
};

export type StoredPaymentClaimRow = {
  attendee_id: number | null;
  failure_data: EnvKeyEncrypted | "";
  payment_reference_index: string;
  payment_session_id: string;
  provider_refunded_at: string;
};

/** One place says which columns a claim needs, so no reader can build a
 *  `StoredRow` that is missing one. */
export const paymentClaimRowsSql = (where: string): string =>
  `SELECT payment_session_id, attendee_id, failure_data,
          payment_reference_index, provider_refunded_at
     FROM processed_payments AS payment
    WHERE ${where}`;

export const readPaymentClaimRows = async (
  tx: TxScope,
  where: string,
  args: InValue[],
): Promise<StoredPaymentClaimRow[]> =>
  resultRows<StoredPaymentClaimRow>(
    await tx.execute({ args, sql: paymentClaimRowsSql(where) }),
  );

/** Read one stored row into the record it carries. */
export const asPaymentRowRecord = async (
  row: StoredPaymentClaimRow,
): Promise<PaymentRowRecord> => ({
  attendeeId: Number(row.attendee_id),
  sessionId: row.payment_session_id,
  slot: row.failure_data,
  state: row.failure_data
    ? readRowState(await decrypt(row.failure_data), SLOT)
    : EMPTY_ROW_STATE,
});

/** Every payment row these attendees own, with its record. Unlike the claim's
 *  read this does not filter by reference: a row that no longer names a charge
 *  can still carry work someone has to finish. Takes the caller's own write
 *  transaction, so it sees what that caller is about to change. */
export const readAttendeeRowStates = async (
  tx: TxScope,
  attendeeIds: readonly number[],
): Promise<PaymentRowRecord[]> =>
  await Promise.all(
    (
      await readPaymentClaimRows(
        tx,
        `attendee_id IN (${inPlaceholders(attendeeIds)})`,
        [...attendeeIds],
      )
    ).map(asPaymentRowRecord),
  );

/** The one statement that puts a record on a row, with the plain word derived
 *  from that same record so the two cannot disagree. Conditioned on the row
 *  still holding exactly what we read, so a row that changed under us matches
 *  nothing. */
export const paymentRowStateStatement = async (
  row: PaymentRowRecord,
  state: PaymentRowState,
): Promise<SqlStatement> => ({
  args: [
    isEmptyRowState(state) ? "" : await encrypt(writeRowState(state, SLOT)),
    mirrorFor(state),
    row.sessionId,
    row.slot,
  ],
  sql: `UPDATE processed_payments
           SET failure_data = ?, protected_state = ?
         WHERE payment_session_id = ? AND failure_data = ?`,
});

/** The rows a run is letting go of, the claim it is letting go of them under,
 *  and which of them carry money the books have not caught up with. One shape
 *  because the three always travel together. */
export type RowRelease = {
  heldSince: string;
  sessionIds: readonly string[];
  unrecorded?: ReadonlySet<string>;
};

/**
 * Let go of the rows a run claimed, leaving whatever else they carry alone.
 *
 * Only the exact `heldSince` claim is released: a run that stalled past the
 * staleness cutoff must not strip the live claim off work another run has
 * since resumed.
 *
 * `unrecorded` names the sessions whose money went back with no ledger entry.
 * The mark goes on as the hold comes off, so the row that proves the money
 * moved is never left unprotected in between — and letting go without it
 * clears an older mark, which is how the state retires when a later run's
 * ledger post finally lands.
 */
const rewriteRows = async (
  sessionIds: readonly string[],
  next: (row: PaymentRowRecord) => PaymentRowState | null,
): Promise<void> => {
  if (sessionIds.length === 0) return;
  // Two batches rather than a transaction: nothing between the read and the
  // write depends on it, and each write is conditioned on the exact record it
  // read. Pinned to the primary because a caller may be reading its own claim
  // — a lagging replica would match no write and leave the claim standing.
  const [read] = await queryBatchPrimary([
    {
      args: [...sessionIds],
      sql: paymentClaimRowsSql(
        `payment_session_id IN (${inPlaceholders(sessionIds)})`,
      ),
    },
  ]);
  const rows = await Promise.all(
    resultRows<StoredPaymentClaimRow>(read!).map(asPaymentRowRecord),
  );
  const writes = await Promise.all(
    mapNotNullish((row: PaymentRowRecord) => {
      const state = next(row);
      return state === null ? undefined : { row, state };
    })(rows).map(({ row, state }) => paymentRowStateStatement(row, state)),
  );
  if (writes.length > 0) await executeBatch(writes);
};

/** The row's record with its books-behind word put on or taken off, leaving
 *  everything else it carries exactly as it was. Both writers of that word go
 *  through here, so neither can disturb what the other leaves alone. */
const sayingBooksAreBehind = (
  state: PaymentRowState,
  marked: boolean,
): PaymentRowState => {
  const { unrecorded: _was, ...kept } = state;
  if (!marked) return kept;
  return {
    ...kept,
    unrecorded:
      state.unrecorded === undefined
        ? { returnedAt: nowIso() }
        : state.unrecorded,
  };
};

export const releaseAttendeeRows = ({
  heldSince,
  sessionIds,
  unrecorded = new Set(),
}: RowRelease): Promise<void> =>
  rewriteRows(sessionIds, (row) => {
    if (row.state.claim?.writtenAt !== heldSince) return null;
    // Letting the claim go does not clear the row: an owner review it still
    // carries has to keep showing.
    const { claim: _released, ...held } = row.state;
    return sayingBooksAreBehind(held, unrecorded.has(row.sessionId));
  });

/**
 * Put on, or take off, the row's word that its money went back and the books
 * have not caught up.
 *
 * For the paths that DISCOVER a refund rather than send one — the refresh
 * route finds the provider already returned a charge. Without a claim to let
 * go of, these are the only writers of that word, so both halves live here:
 * the marker whose absence would let the row be deleted before anyone reaches
 * the correction, and its retirement when a later run's ledger post lands. A
 * marker nothing can take off is its own trap — a placeholder never enters the
 * refund route that clears one, so it would refuse deletion for good.
 *
 * Either half leaves a row that already says what is wanted completely alone,
 * so repeated refreshes neither move the date somebody is meant to be looking
 * into nor touch a row they have nothing to say about.
 */
const returnedUnrecorded =
  (marked: boolean) =>
  (sessionIds: readonly string[]): Promise<void> =>
    rewriteRows(sessionIds, (row) =>
      (row.state.unrecorded !== undefined) === marked
        ? null
        : sayingBooksAreBehind(row.state, marked),
    );

export const markReturnedUnrecorded = returnedUnrecorded(true);
export const clearReturnedUnrecorded = returnedUnrecorded(false);
