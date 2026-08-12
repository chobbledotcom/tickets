/**
 * Reading, rewriting, and letting go of the rows a refund run holds. Taking
 * the all-or-none hold lives in `payment-claim/take.ts`.
 */

/* jscpd:ignore-start -- imports */
import type { InValue } from "@libsql/client";
import { mapNotNullish, requiredMapValue } from "#fp";
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
  type HeldRefundCommand,
  holdsExactRefundCommand,
} from "#shared/payment/claim.ts";
import {
  openPaymentReview,
  type PaymentReviewReason,
} from "#shared/payment/review.ts";
import {
  EMPTY_ROW_STATE,
  isEmptyRowState,
  type PaymentRowState,
  type RefundClaim,
  type RefundClaimPhase,
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

export type HeldPaymentRowRecord = {
  readonly claim: RefundClaim;
  readonly record: PaymentRowRecord;
};

/** Decode a row only when it still carries the exact refund command. */
export const paymentRowHeldBy = async (
  row: StoredPaymentClaimRow,
  command: Pick<HeldRefundCommand, "commandId" | "heldSince">,
): Promise<HeldPaymentRowRecord | null> => {
  const record = await asPaymentRowRecord(row);
  const claim = record.state.claim;
  return holdsExactRefundCommand(claim, command) ? { claim, record } : null;
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
    rows.some((row) => {
      const stored = row.state.claim;
      return (
        stored === undefined ||
        stored.commandId !== claim.commandId ||
        stored.writtenAt !== claim.heldSince ||
        stored.phase !==
          requiredMapValue(
            claim.phases,
            row.sessionId,
            `Refund confirmation lost payment-row phase ${row.sessionId}`,
          )
      );
    })
  ) {
    throw new Error("Refund confirmation no longer owns every payment row");
  }
};

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

export type PaymentReviewChange =
  | { readonly kind: "review"; readonly reason: PaymentReviewReason }
  | {
      readonly kind: "resolved";
      readonly reason: PaymentReviewReason["kind"];
    };

export type PaymentBooksChange = "recorded" | "unrecorded";

/** Every change one run can make to one exact row. Omitted facts are
 * preserved; no absence silently clears an older repair target. */
export type PaymentRowSettlement = {
  readonly books?: PaymentBooksChange;
  readonly claim: "keep" | "release";
  readonly phase: RefundClaimPhase;
  readonly review?: PaymentReviewChange;
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
 * A row can keep its claim while recording a discovered review or missed
 * ledger write. This matters when one sibling is settled and another provider
 * answer is still in doubt. Every other field is preserved unless its change
 * is named explicitly.
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

/** Put on or take off the row's books-behind word without disturbing its
 * other state. A retry keeps the date the first failed ledger write stored. */
const withBooksChange = (
  state: PaymentRowState,
  change: PaymentBooksChange | undefined,
): PaymentRowState => {
  if (change === undefined) return state;
  const { unrecorded: _was, ...kept } = state;
  if (change === "recorded") return kept;
  return {
    ...kept,
    unrecorded:
      state.unrecorded === undefined
        ? { returnedAt: nowIso() }
        : state.unrecorded,
  };
};

/** Apply only the review decision this run made, preserving it when the run
 * made none. */
const withReviewChange = (
  state: PaymentRowState,
  change: PaymentReviewChange | undefined,
): PaymentRowState => {
  if (change === undefined) return state;
  if (
    change.kind === "resolved" &&
    state.review?.reason.kind !== change.reason
  ) {
    return state;
  }
  if (
    change.kind === "review" &&
    state.review?.reason.kind === change.reason.kind
  ) {
    return state;
  }
  const { review: _was, ...kept } = state;
  return change.kind === "resolved"
    ? kept
    : { ...kept, review: openPaymentReview(change.reason) };
};

const withClaimChange = (
  state: PaymentRowState,
  change: PaymentRowSettlement["claim"],
): PaymentRowState => {
  if (change === "keep") return state;
  const { claim: _released, ...kept } = state;
  return kept;
};

export const settleAttendeeRows = ({
  commandId,
  heldSince,
  rows,
}: RowSettlement): Promise<void> =>
  rewriteRows([...rows.keys()], (row) => {
    const change = requiredMapValue(
      rows,
      row.sessionId,
      `Refund settlement lost payment row ${row.sessionId}`,
    );
    const claim = row.state.claim;
    if (
      claim === undefined ||
      claim.commandId !== commandId ||
      claim.writtenAt !== heldSince ||
      claim.phase !== change.phase
    )
      return null;
    return withClaimChange(
      withReviewChange(withBooksChange(row.state, change.books), change.review),
      change.claim,
    );
  });
