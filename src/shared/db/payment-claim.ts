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
  executeBatch,
  inPlaceholders,
  queryBatchPrimary,
  resultRows,
  type TxScope,
  withTransaction,
} from "#shared/db/client.ts";
import { STALE_RESERVATION_MS } from "#shared/limits.ts";
import { isoBefore, nowIso } from "#shared/now.ts";
import {
  type ClaimDecision,
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

/** What the one consumer that cannot decrypt sees. It carries the claim's
 *  written-at time as well as the word, because that reader also has to tell a
 *  live claim from a crashed worker's — a claim that is never released (a
 *  keyless run whose answer was lost) would otherwise keep its row from ever
 *  being pruned. */
export const claimMirror = (writtenAt: string): string => `claim:${writtenAt}`;

/** Where the written-at time starts inside the mirror, 1-indexed for SQL's
 *  `substr`. Exported so the prune reads the same offset this writes. */
export const CLAIM_MIRROR_TIME_AT = "claim:".length + 1;

/** One row as the claim transaction found it. The stored slot is kept exactly
 *  as read, because every write back is conditioned on it being unchanged. */
type ClaimRow = {
  readonly attendeeId: number;
  readonly sessionId: string;
  readonly slot: string;
  readonly state: PaymentRowState;
};

/** What happened when a run asked for an attendee's rows. */
export type ClaimResult =
  | { blockedBy: ClaimDecision; kind: "blocked" }
  | { heldSince: string; kind: "claimed"; sessionIds: readonly string[] };

type StoredRow = {
  attendee_id: number | null;
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
      sql: `SELECT payment_session_id, attendee_id, failure_data,
                   payment_reference_index
              FROM processed_payments AS payment
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
  attendeeIds: readonly number[],
): Promise<{ own: StoredRow[]; sharing: StoredRow[] }> => {
  const own = await readRows(
    tx,
    `attendee_id IN (${inPlaceholders(attendeeIds)}) AND payment_reference != ''`,
    [...attendeeIds],
  );
  const indexes = own
    .map((row) => row.payment_reference_index)
    .filter((index) => index !== "");
  if (indexes.length === 0) return { own, sharing: [] };
  const sharing = await readRows(
    tx,
    `attendee_id NOT IN (${inPlaceholders(attendeeIds)})
       AND payment_reference_index IN (${inPlaceholders(indexes)})`,
    [...attendeeIds, ...indexes],
  );
  return { own, sharing };
};

/** Read one stored row into the record it carries. */
const asClaimRow = async (row: StoredRow): Promise<ClaimRow> => ({
  attendeeId: Number(row.attendee_id),
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
 * Claim every row this run will touch, or none of them.
 *
 * One transaction for the whole run, however many attendees it covers: a bulk
 * wave claims all of them together, so it costs the same two round trips as a
 * single refund and cannot end up holding some attendees but not others. The
 * rows a run reads are the rows it claims — a reference landing between the
 * read and the write cannot slip in unclaimed, and a competing run either
 * lands wholly before us or wholly after.
 *
 * Each row's claim names the attendee that row belongs to, not the run, so a
 * crashed wave is resumed one attendee at a time by whoever claims that
 * attendee's whole set again.
 */
export const claimAttendeeRows = async (
  attendeeIds: readonly number[],
  capability: RefundCapability,
): Promise<ClaimResult> => {
  if (attendeeIds.length === 0) {
    return { heldSince: nowIso(), kind: "claimed", sessionIds: [] };
  }
  const writtenAt = nowIso();
  const staleBefore = isoBefore(STALE_RESERVATION_MS);
  return await withTransaction(async (tx) => {
    const stored = await readClaimableRows(tx, attendeeIds);
    const rows = await Promise.all(stored.own.map(asClaimRow));
    // A claim held anywhere on the same provider reference is a claim on the
    // same money, so another attendee's row blocks us even though we never
    // write to it. Seeing it is enough: write transactions run one at a time,
    // so a competing run has either committed its claim before we look or
    // cannot start until we are done.
    const sharing = await Promise.all(stored.sharing.map(asClaimRow));
    // Every row is judged as its own attendee's: that is what lets a crashed
    // run's rows be picked up one attendee at a time, and what makes a live
    // claim on a shared reference read as "someone is working on this".
    const refused = [...rows, ...sharing]
      .map((row) =>
        decideClaim(
          row.state.claim,
          { attendeeId: row.attendeeId, scope: "attendee_set" },
          staleBefore,
        ),
      )
      .find((decision) => !holdsTheRow(decision));
    if (refused !== undefined) return { blockedBy: refused, kind: "blocked" };
    for (const row of rows) {
      await writeState(
        tx,
        row,
        {
          ...row.state,
          claim: {
            attendeeId: row.attendeeId,
            capability,
            scope: "attendee_set",
            writtenAt,
          },
        },
        claimMirror(writtenAt),
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
  // Two batches rather than an interactive transaction: releasing needs to
  // read each record and write it back without its claim, but nothing in
  // between depends on the write, and each write is conditioned on the exact
  // record it read. A batch is one round trip where a transaction is several,
  // and a refund request has few to spare.
  //
  // The read is pinned to the primary because it is reading this run's own
  // claim: a lagging replica would hand back the record from before the claim
  // landed, no write would match, and the claim would sit there until it went
  // stale — blocking a retry that should have been free.
  const [read] = await queryBatchPrimary([
    {
      args: [...sessionIds],
      sql: `SELECT payment_session_id, attendee_id, failure_data,
                   payment_reference_index
              FROM processed_payments AS payment
             WHERE payment_session_id IN (${inPlaceholders(sessionIds)})`,
    },
  ]);
  const rows = await Promise.all(resultRows<StoredRow>(read!).map(asClaimRow));
  const writes = await Promise.all(
    rows
      .filter((row) => row.state.claim?.writtenAt === heldSince)
      .map(async (row) => {
        const { claim: _released, ...kept } = row.state;
        return {
          args: [
            isEmptyRowState(kept)
              ? ""
              : await encrypt(writeRowState(kept, SLOT)),
            row.sessionId,
            row.slot,
          ],
          sql: `UPDATE processed_payments
                   SET failure_data = ?, protected_state = ''
                 WHERE payment_session_id = ? AND failure_data = ?`,
        };
      }),
  );
  if (writes.length > 0) await executeBatch(writes);
};
