/**
 * Taking and letting go of the hold a refund run keeps on an attendee's
 * payment rows.
 *
 * A run claims every row it will touch before it reads a provider, and keeps
 * the claim until it has written down what happened. Two runs can then never
 * both look at an untouched charge, decide it is refundable, and each send the
 * money — the second one to arrive is told a refund is already in progress and
 * never reaches the provider.
 *
 * The claim is all-or-none per attendee: a run takes the whole reference set in
 * one transaction or takes nothing. Splitting a merged attendee's references
 * between two runs would move part of someone's money and leave the rest, which
 * is worse than refusing.
 */

/* jscpd:ignore-start -- imports */
import type { InValue } from "@libsql/client";
import { decrypt, encrypt } from "#shared/crypto/encryption.ts";
import type { EnvKeyEncrypted } from "#shared/crypto/sealed.ts";
import {
  inPlaceholders,
  resultRows,
  type TxScope,
  withTransaction,
} from "#shared/db/client.ts";
import { STALE_RESERVATION_MS } from "#shared/limits.ts";
import { isoBefore, nowIso } from "#shared/now.ts";
import {
  type ClaimDecision,
  type ClaimRequest,
  decideClaim,
  holdsTheRow,
} from "#shared/payment/claim.ts";
import {
  EMPTY_ROW_STATE,
  isEmptyRowState,
  type PaymentRowState,
  type RefundCapability,
  readRowState,
  writeRowState,
} from "#shared/payment/row-state.ts";

/* jscpd:ignore-end */

const SLOT = "processed_payments.failure_data";

/** The plaintext word the one consumer that cannot decrypt routes on. Live
 *  refund work keeps a row from being pruned out from under it. */
const CLAIMED_STATE = "claim";

/** One row as the claim transaction found it. The stored slot is kept exactly
 *  as read, because every write back is conditioned on it being unchanged. */
type ClaimRow = {
  readonly sessionId: string;
  readonly slot: string;
  readonly state: PaymentRowState;
};

/** What happened when a run asked for an attendee's rows. */
export type ClaimResult =
  | { blockedBy: ClaimDecision; kind: "blocked" }
  | { heldSince: string; kind: "claimed"; sessionIds: readonly string[] };

type StoredRow = {
  failure_data: EnvKeyEncrypted | "";
  payment_reference_index: string;
  payment_session_id: string;
};

/** The columns every claim decision reads, for whichever rows the caller
 *  names. One place says which columns a claim needs. */
const readRows = async (
  tx: TxScope,
  where: string,
  args: InValue[],
): Promise<StoredRow[]> =>
  resultRows<StoredRow>(
    await tx.execute({
      args,
      sql: `SELECT payment_session_id, failure_data, payment_reference_index
              FROM processed_payments
             WHERE ${where}`,
    }),
  );

/**
 * Every row that holds this attendee's refundable money, plus every OTHER row
 * carrying one of the same provider references.
 *
 * The second half is what stops two attendees who share one legacy reference
 * from each claiming their own row and racing two payouts against one charge:
 * a claim anywhere on the reference is a claim on the money.
 */
const readClaimableRows = async (
  tx: TxScope,
  attendeeId: number,
): Promise<{ own: StoredRow[]; sharing: StoredRow[] }> => {
  const own = await readRows(
    tx,
    "attendee_id = ? AND payment_reference != ''",
    [attendeeId],
  );
  const indexes = own
    .map((row) => row.payment_reference_index)
    .filter((index) => index !== "");
  if (indexes.length === 0) return { own, sharing: [] };
  const sharing = await readRows(
    tx,
    `attendee_id IS NOT ? AND payment_reference_index IN (${inPlaceholders(indexes)})`,
    [attendeeId, ...indexes],
  );
  return { own, sharing };
};

/** Read one stored row into the record it carries. */
const asClaimRow = async (row: StoredRow): Promise<ClaimRow> => ({
  sessionId: row.payment_session_id,
  slot: row.failure_data,
  state: row.failure_data
    ? readRowState(await decrypt(row.failure_data), SLOT)
    : EMPTY_ROW_STATE,
});

/**
 * Write a row's record back, but only while it still holds exactly what we
 * read. A row that changed under us fails its condition, which rolls the whole
 * claim back rather than letting a run hold half a set.
 */
const writeState = async (
  tx: TxScope,
  row: ClaimRow,
  state: PaymentRowState,
  protectedState: string,
): Promise<void> => {
  const slot = isEmptyRowState(state)
    ? ""
    : await encrypt(writeRowState(state, SLOT));
  const result = await tx.execute({
    args: [slot, protectedState, row.sessionId, row.slot],
    sql: `UPDATE processed_payments
             SET failure_data = ?, protected_state = ?
           WHERE payment_session_id = ? AND failure_data = ?`,
  });
  if (result.rowsAffected !== 1) {
    throw new Error(
      `Payment row changed while being claimed: ${row.sessionId}`,
    );
  }
};

/**
 * Claim every row this attendee's refund run will touch, or none of them.
 *
 * Runs inside one write transaction, so the rows a run reads are the rows it
 * claims: a reference landing between the read and the write cannot slip in
 * unclaimed, and a competing run either lands wholly before us or wholly after.
 */
export const claimAttendeeRows = async (
  attendeeId: number,
  capability: RefundCapability,
): Promise<ClaimResult> => {
  const request: ClaimRequest = { attendeeId, scope: "attendee_set" };
  const writtenAt = nowIso();
  const staleBefore = isoBefore(STALE_RESERVATION_MS);
  return await withTransaction(async (tx) => {
    const stored = await readClaimableRows(tx, attendeeId);
    const rows = await Promise.all(stored.own.map(asClaimRow));
    // A claim held anywhere on the same provider reference is a claim on the
    // same money, so another attendee's row blocks us even though we never
    // write to it. Seeing it is enough: write transactions run one at a time,
    // so a competing run has either committed its claim before we look or
    // cannot start until we are done.
    const sharing = await Promise.all(stored.sharing.map(asClaimRow));
    const refused = [...rows, ...sharing]
      .map((row) => decideClaim(row.state.claim, request, staleBefore))
      .find((decision) => !holdsTheRow(decision));
    if (refused !== undefined) return { blockedBy: refused, kind: "blocked" };
    for (const row of rows) {
      await writeState(
        tx,
        row,
        {
          ...row.state,
          claim: { attendeeId, capability, scope: "attendee_set", writtenAt },
        },
        CLAIMED_STATE,
      );
    }
    return {
      heldSince: writtenAt,
      kind: "claimed",
      sessionIds: rows.map((row) => row.sessionId),
    };
  });
};

/**
 * Let go of the rows a run claimed, leaving whatever else they carry alone.
 *
 * `heldSince` is the run's own claim, and only that exact claim is released. A
 * run that stalled past the staleness cutoff may wake up to find another run
 * has resumed its rows; releasing then would strip the live claim off work
 * that is still going and let a third run in behind it. So a claim that is no
 * longer ours is left exactly where it is.
 */
export const releaseAttendeeRows = async (
  sessionIds: readonly string[],
  heldSince: string,
): Promise<void> => {
  if (sessionIds.length === 0) return;
  await withTransaction(async (tx) => {
    const rows = await readRows(
      tx,
      `payment_session_id IN (${inPlaceholders(sessionIds)})`,
      [...sessionIds],
    );
    for (const stored of rows) {
      const row = await asClaimRow(stored);
      if (row.state.claim?.writtenAt !== heldSince) continue;
      const { claim: _released, ...kept } = row.state;
      await writeState(tx, row, kept, "");
    }
  });
};
