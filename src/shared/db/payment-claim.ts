/**
 * Reading, rewriting, and letting go of the rows a refund run holds. Taking
 * the all-or-none hold lives in `payment-claim/take.ts`.
 */

/* jscpd:ignore-start -- imports */
import type { InValue } from "@libsql/client";
import { decrypt, encrypt } from "#crypto/encryption.ts";
import type { EnvKeyEncrypted } from "#crypto/sealed.ts";
import {
  executeBatch,
  inPlaceholders,
  queryBatchPrimary,
  resultRows,
  type SqlStatement,
  type TxScope,
} from "#db/client.ts";
import { mapNotNullish, requiredMapValue } from "#fp";
import { mirrorFor } from "#payment/admit-move.ts";
import { refundAuthorityWorkSql } from "#payment/refund-authority-lifecycle.ts";
import {
  EMPTY_ROW_STATE,
  isEmptyRowState,
  type PaymentRowState,
  type RefundClaimPhase,
  readRowState,
  writeRowState,
} from "#payment/row-state.ts";
import {
  claimHeldBy,
  type PaymentRowSettlement,
  settledRowState,
} from "#payment/row-transitions.ts";
import { nowIso } from "#shared/now.ts";

/* jscpd:ignore-end */

const SLOT = "processed_payments.failure_data";

/** One row as the reading transaction found it. The stored slot is kept exactly
 *  as read, because every write back is conditioned on it being unchanged. */
export type PaymentRowRecord = {
  readonly attendeeId: number;
  readonly providerRefundWork: boolean;
  readonly sessionId: string;
  readonly slot: string;
  readonly state: PaymentRowState;
};

/** Keep only rows carrying one named piece of payment work. */
export const paymentRowsWith = <T>(
  rows: readonly PaymentRowRecord[],
  value: (state: PaymentRowState) => T | undefined,
): { readonly row: PaymentRowRecord; readonly value: T }[] =>
  mapNotNullish((row: PaymentRowRecord) => {
    const found = value(row.state);
    return found === undefined ? null : { row, value: found };
  })(rows);

export type StoredPaymentClaimRow = {
  attendee_id: number | null;
  failure_data: EnvKeyEncrypted | "";
  payment_reference_index: string;
  provider_refund_work: number;
  payment_session_id: string;
  refund_state_name: string | null;
};

/** One place says which columns a claim needs, so no reader can build a
 *  `StoredRow` that is missing one. */
export const paymentClaimRowsSql = (where: string): string =>
  `SELECT payment_session_id, attendee_id, failure_data,
          payment_reference_index, charge.refund_state_name,
          CASE WHEN ${refundAuthorityWorkSql("charge.")}
            THEN 1 ELSE 0 END AS provider_refund_work
     FROM processed_payments AS payment
     LEFT JOIN payment_charges AS charge
       ON charge.reference_index = payment.payment_reference_index
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
): Promise<PaymentRowRecord> => {
  if (row.provider_refund_work !== 0 && row.provider_refund_work !== 1) {
    throw new Error("Provider refund work projection is invalid");
  }
  return {
    attendeeId: Number(row.attendee_id),
    providerRefundWork: row.provider_refund_work === 1,
    sessionId: row.payment_session_id,
    slot: row.failure_data,
    state: row.failure_data
      ? readRowState(await decrypt(row.failure_data), SLOT)
      : EMPTY_ROW_STATE,
  };
};

/** Decode the row-state slots returned by either payment-row reader. */
const asPaymentRowRecords = (
  rows: readonly StoredPaymentClaimRow[],
): Promise<PaymentRowRecord[]> => Promise.all(rows.map(asPaymentRowRecord));

/** Every payment row these attendees own, with its record. Unlike the claim's
 *  read this does not filter by reference: a row that no longer names a charge
 *  can still carry work someone has to finish. Takes the caller's own write
 *  transaction, so it sees what that caller is about to change. */
export const readAttendeeRowStates = async (
  tx: TxScope,
  attendeeIds: readonly number[],
): Promise<PaymentRowRecord[]> =>
  await asPaymentRowRecords(
    await readPaymentClaimRows(
      tx,
      `attendee_id IN (${inPlaceholders(attendeeIds)})`,
      [...attendeeIds],
    ),
  );

/** Read payment-row work from the primary without opening a write transaction. */
export const loadAttendeeRowStates = async (
  attendeeIds: readonly number[],
): Promise<PaymentRowRecord[]> => {
  const [read] = await queryBatchPrimary([
    {
      args: [...attendeeIds],
      sql: paymentClaimRowsSql(
        `attendee_id IN (${inPlaceholders(attendeeIds)})`,
      ),
    },
  ]);
  return asPaymentRowRecords(resultRows<StoredPaymentClaimRow>(read!));
};

/** Fail when a confirmer no longer owns every payment row it started with. */
export const assertRefundRowsHeld = async (
  tx: TxScope,
  claim: {
    commandId: string;
    heldSince: string;
    phases: ReadonlyMap<string, RefundClaimPhase>;
  },
): Promise<void> => {
  const sessionIds = [...claim.phases.keys()];
  const stored =
    sessionIds.length === 0
      ? []
      : await readPaymentClaimRows(
          tx,
          `payment_session_id IN (${inPlaceholders(sessionIds)})`,
          sessionIds,
        );
  const rows = await Promise.all(stored.map(asPaymentRowRecord));
  if (
    rows.length !== sessionIds.length ||
    rows.some(
      (row) =>
        !claimHeldBy(row.state.claim, {
          commandId: claim.commandId,
          heldSince: claim.heldSince,
          phase: requiredMapValue(
            claim.phases,
            row.sessionId,
            "Refund confirmation lost a payment-row phase",
          ),
        }),
    )
  ) {
    throw new Error("Refund confirmation no longer owns every payment row");
  }
};

/** The one statement that puts a record on a row, with the plain word derived
 *  from that same record so the two cannot disagree. Conditioned on the row
 *  still holding exactly what we read, so a row that changed under us matches
 *  nothing. */
export interface StoredPaymentRowState {
  readonly failureData: EnvKeyEncrypted | "";
  readonly protectedState: string;
}

/** Produce the encrypted record and its non-sensitive mirror together. */
export const paymentRowStateValues = async (
  state: PaymentRowState,
): Promise<StoredPaymentRowState> => ({
  failureData: isEmptyRowState(state)
    ? ""
    : await encrypt(writeRowState(state, SLOT)),
  protectedState: mirrorFor(state),
});

export const paymentRowStateStatement = async (
  row: PaymentRowRecord,
  state: PaymentRowState,
): Promise<SqlStatement> => {
  const stored = await paymentRowStateValues(state);
  return {
    args: [stored.failureData, stored.protectedState, row.sessionId, row.slot],
    sql: `UPDATE processed_payments
           SET failure_data = ?, protected_state = ?
         WHERE payment_session_id = ? AND failure_data = ?`,
  };
};

/** The exact row transitions made under one durable claim. */
export type RowSettlement = {
  readonly commandId: string;
  readonly heldSince: string;
  readonly rows: ReadonlyMap<string, PaymentRowSettlement>;
};

/**
 * Let go of the rows a run claimed, leaving whatever else they carry alone.
 *
 * Only the exact `heldSince` claim is released: a run that stalled past the
 * staleness cutoff must not strip the live claim off work another run has
 * since resumed.
 *
 * Every settlement releases the short-lived fence. Provider uncertainty is
 * durable provider-refund work, not a reason to retain an attendee-row claim.
 * Every other field is preserved unless its change is named explicitly.
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
  const rows = await asPaymentRowRecords(
    resultRows<StoredPaymentClaimRow>(read!),
  );
  const writes = await Promise.all(
    mapNotNullish((row: PaymentRowRecord) => {
      const state = next(row);
      return state === null ? undefined : { row, state };
    })(rows).map(({ row, state }) => paymentRowStateStatement(row, state)),
  );
  if (writes.length > 0) await executeBatch(writes);
};

export const settleAttendeeRows = ({
  commandId,
  heldSince,
  rows,
}: RowSettlement): Promise<void> =>
  rewriteRows([...rows.keys()], (row) =>
    settledRowState(
      row.state,
      requiredMapValue(
        rows,
        row.sessionId,
        "Refund settlement lost a payment row",
      ),
      { commandId, heldSince },
      nowIso(),
    ),
  );
