/**
 * Taking and letting go of the hold a refund run keeps on an attendee's
 * payment rows. A run claims every row it will touch before it reads a
 * provider and keeps the claim until it has written down what happened, so two
 * runs can never both decide one untouched charge is refundable.
 *
 * All-or-none per attendee: splitting a merged attendee's references between
 * two runs would move part of someone's money and leave the rest.
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
  type SqlStatement,
  type TxScope,
  withTransaction,
} from "#shared/db/client.ts";
import { STALE_RESERVATION_MS } from "#shared/limits.ts";
import { isoBefore, nowIso } from "#shared/now.ts";
import { mirrorFor } from "#shared/payment/admit-move.ts";
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

/** One row as the reading transaction found it. The stored slot is kept exactly
 *  as read, because every write back is conditioned on it being unchanged. */
export type PaymentRowRecord = {
  readonly attendeeId: number;
  readonly sessionId: string;
  readonly slot: string;
  readonly state: PaymentRowState;
};

/** What happened when a run asked for an attendee's rows. */
export type ClaimResult =
  | { blockedBy: ClaimDecision; kind: "blocked" }
  | {
      /** Each attendee's claimed rows, kept apart so a run can let one
       *  attendee go while another's answer is still in doubt. Settlement is
       *  per attendee, so the release has to be too. */
      held: ReadonlyMap<number, readonly string[]>;
      heldSince: string;
      kind: "claimed";
      /** The reference indexes whose claimed row already says the money went
       *  back. Read instead of the reference list this run loaded before it
       *  had the hold, which can predate another run's answer. */
      returned: ReadonlySet<string>;
    };

type StoredRow = {
  attendee_id: number | null;
  failure_data: EnvKeyEncrypted | "";
  payment_reference_index: string;
  payment_session_id: string;
  provider_refunded_at: string;
};

/** One place says which columns a claim needs, so no reader can build a
 *  `StoredRow` that is missing one. */
const claimRowsSql = (where: string): string =>
  `SELECT payment_session_id, attendee_id, failure_data,
          payment_reference_index, provider_refunded_at
     FROM processed_payments AS payment
    WHERE ${where}`;

const readRows = async (
  tx: TxScope,
  where: string,
  args: InValue[],
): Promise<StoredRow[]> =>
  resultRows<StoredRow>(await tx.execute({ args, sql: claimRowsSql(where) }));

/** Every row holding this attendee's refundable money, plus every OTHER row
 *  carrying the same provider reference — a claim anywhere on the reference is
 *  a claim on the money, so two attendees sharing one legacy charge cannot
 *  race two payouts against it. */
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
const asRowRecord = async (row: StoredRow): Promise<PaymentRowRecord> => ({
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
      await readRows(tx, `attendee_id IN (${inPlaceholders(attendeeIds)})`, [
        ...attendeeIds,
      ])
    ).map(asRowRecord),
  );

/** The one statement that puts a record on a row, with the plain word derived
 *  from that same record so the two cannot disagree. Conditioned on the row
 *  still holding exactly what we read, so a row that changed under us matches
 *  nothing. */
const rowStateStatement = async (
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

/** Write a row's record back inside the claim's own transaction. */
const writeState = async (
  tx: TxScope,
  row: PaymentRowRecord,
  state: PaymentRowState,
): Promise<void> => {
  await tx.execute(await rowStateStatement(row, state));
};

/**
 * Claim every row this run will touch, or none of them. One transaction for
 * the whole run, so it costs the same two round trips however many attendees
 * it covers and cannot end up holding some but not others.
 *
 * Each row's claim names the attendee it belongs to, not the run, so a crashed
 * wave is resumed one attendee at a time.
 */
export const claimAttendeeRows = async (
  attendeeIds: readonly number[],
  capability: RefundCapability,
): Promise<ClaimResult> => {
  if (attendeeIds.length === 0) {
    return {
      held: new Map(),
      heldSince: nowIso(),
      kind: "claimed",
      returned: new Set(),
    };
  }
  const writtenAt = nowIso();
  const staleBefore = isoBefore(STALE_RESERVATION_MS);
  return await withTransaction(async (tx) => {
    const stored = await readClaimableRows(tx, attendeeIds);
    const rows = await Promise.all(stored.own.map(asRowRecord));
    // Seeing a competing claim is enough: write transactions run one at a
    // time, so a rival has either committed before we look or cannot start
    // until we are done.
    const sharing = await Promise.all(stored.sharing.map(asRowRecord));
    // Our own rows are judged as their attendee's, which is what lets a
    // crashed run be picked up one attendee at a time.
    const refused = rows
      .map((row) =>
        decideClaim(
          row.state.claim,
          { attendeeId: row.attendeeId, scope: "attendee_set" },
          staleBefore,
        ),
      )
      .find((decision) => !holdsTheRow(decision));
    if (refused !== undefined) return { blockedBy: refused, kind: "blocked" };
    // Someone else's row stops us whether its claim is stale or not: we never
    // write to it, so we could not take it over, and sending against money
    // another claim still holds is how one charge is refunded twice.
    if (sharing.some((row) => row.state.claim !== undefined)) {
      return { blockedBy: { kind: "foreign" }, kind: "blocked" };
    }
    for (const row of rows) {
      await writeState(tx, row, {
        ...row.state,
        claim: {
          attendeeId: row.attendeeId,
          capability,
          scope: "attendee_set",
          writtenAt,
        },
      });
    }
    return {
      held: new Map(
        [...Map.groupBy(rows, (row) => row.attendeeId)].map(
          ([attendeeId, owned]) => [
            attendeeId,
            owned.map((row) => row.sessionId),
          ],
        ),
      ),
      heldSince: writtenAt,
      kind: "claimed",
      // Sharing rows count too: money returned against a reference is
      // returned for every row carrying it, whoever they belong to.
      returned: new Set(
        [...stored.own, ...stored.sharing]
          .filter((row) => row.provider_refunded_at !== "")
          .map((row) => row.payment_reference_index),
      ),
    };
  });
};

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
export const releaseAttendeeRows = async ({
  heldSince,
  sessionIds,
  unrecorded = new Set(),
}: RowRelease): Promise<void> => {
  if (sessionIds.length === 0) return;
  // Two batches rather than a transaction: nothing between the read and the
  // write depends on it, and each write is conditioned on the exact record it
  // read. Pinned to the primary because it reads this run's own claim — a
  // lagging replica would match no write and leave the claim standing.
  const [read] = await queryBatchPrimary([
    {
      args: [...sessionIds],
      sql: claimRowsSql(
        `payment_session_id IN (${inPlaceholders(sessionIds)})`,
      ),
    },
  ]);
  const rows = await Promise.all(resultRows<StoredRow>(read!).map(asRowRecord));
  const writes = await Promise.all(
    rows
      .filter((row) => row.state.claim?.writtenAt === heldSince)
      .map(async (row) => {
        // Letting the claim go does not clear the row: an owner review it
        // still carries has to keep showing.
        const { claim: _released, unrecorded: _settled, ...kept } = row.state;
        return await rowStateStatement(
          row,
          unrecorded.has(row.sessionId)
            ? { ...kept, unrecorded: { returnedAt: nowIso() } }
            : kept,
        );
      }),
  );
  if (writes.length > 0) await executeBatch(writes);
};
