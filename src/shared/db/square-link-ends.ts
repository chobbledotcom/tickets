/**
 * The queue of unpaid Square checkouts whose payment link must end, and the
 * one row per checkout that carries the sealed link id the task needs to end
 * it.
 *
 * Every write is conditional on the state and the attempt time the row was
 * read with, so two runners that looked at one row cannot both believe they
 * wrote it — the loser finds no row. The state words and the moves between
 * them are declared in `shared/payment/square-link-end-machine-spec.ts`; this
 * module holds only the SQL that carries them out.
 */

import { encrypt } from "#crypto/encryption.ts";
import { hmacHash } from "#crypto/hashing.ts";
import { execute, queryAll } from "#db/client.ts";
import { sql, sqlList } from "#db/sql.ts";
import {
  LINK_END_CHECKABLE_NODES,
  parseSquareLinkEndState,
  type SquareLinkEndEventId,
  type SquareLinkEndState,
  squareLinkEndMoveTo,
} from "#payment/square-link-end-machine-spec.ts";
import { isoAfter, nowIso } from "#shared/now.ts";
import {
  SQUARE_LINK_EXPIRY_BATCH,
  SQUARE_LINK_LEASE_MS,
  SQUARE_LINK_RETRY_MS,
} from "#shared/square/limits.ts";

/** One handle row the expiry task is about to act on. The link id stays
 * sealed: this is the queue, not the opening of a row. */
export type DueSquareLinkEnd = {
  /** The next attempt time as read, which every conditional write must match. */
  readonly claimedAt: string;
  readonly sealedHandle: string;
  readonly sessionIndex: string;
  readonly state: SquareLinkEndState;
};

/**
 * The oldest link ends whose attempt time has come, newest-last so a row that
 * keeps failing cannot hold the front of the queue. A `pending` row is due
 * when its window closed; an `ending` row is due when its lease expired.
 */
export const getDueSquareLinkEnds = async (): Promise<DueSquareLinkEnd[]> => {
  const rows = await queryAll<{
    next_attempt_at: string;
    sealed_handle: string;
    session_index: string;
    state: string;
  }>(
    sql`SELECT session_index, sealed_handle, state, next_attempt_at
       FROM square_link_ends
      WHERE state IN (${sqlList(LINK_END_CHECKABLE_NODES)})
        AND next_attempt_at <= ${nowIso()}
      ORDER BY next_attempt_at
      LIMIT ${SQUARE_LINK_EXPIRY_BATCH}`,
  );
  return rows.map((row) => ({
    claimedAt: row.next_attempt_at,
    sealedHandle: row.sealed_handle,
    sessionIndex: row.session_index,
    state: parseSquareLinkEndState(row.state),
  }));
};

/**
 * Stage the cancel handle for a checkout the moment Square accepts it. The
 * first attempt lands exactly at the window, so no claim can end a link the
 * buyer can still pay. A retried checkout is a new order, so a new row — no
 * conflict can name an existing one.
 */
export const stageSquareLinkEnd = async (
  sessionId: string,
  linkId: string,
  linkEndsAt: string,
): Promise<void> => {
  const sessionIndex = await hmacHash(sessionId);
  const sealedHandle = await encrypt(linkId);
  const state = squareLinkEndMoveTo("unwritten", "checkout_created");
  await execute(
    sql`INSERT INTO square_link_ends
               (session_index, state, sealed_handle, link_ends_at,
                next_attempt_at, created_at)
             VALUES (${sessionIndex}, ${state}, ${sealedHandle}, ${linkEndsAt}, ${linkEndsAt}, ${nowIso()})`,
  );
};

/** Write a state and an attempt time to a row that is still as this worker
 * read it. Returns whether the write landed. */
const moveRowAsRead = async (
  row: DueSquareLinkEnd,
  state: string,
  nextAttemptAt: string,
): Promise<boolean> => {
  const result = await execute(
    sql`UPDATE square_link_ends
        SET state = ${state}, next_attempt_at = ${nextAttemptAt}
      WHERE session_index = ${row.sessionIndex} AND state = ${row.state} AND next_attempt_at = ${row.claimedAt}`,
  );
  return result.rowsAffected === 1;
};

/**
 * Claim one row for this worker, giving it a lease to answer inside. Returns
 * the lease's attempt time — the value the following write must match — or
 * null when another worker or the completion got there first.
 */
export const claimSquareLinkEnd = async (
  row: DueSquareLinkEnd,
): Promise<string | null> => {
  const leaseUntil = isoAfter(SQUARE_LINK_LEASE_MS);
  const claimed = await moveRowAsRead(
    row,
    squareLinkEndMoveTo("pending", "claim_due"),
    leaseUntil,
  );
  return claimed ? leaseUntil : null;
};

/** The attempt time a row carries after one event lands on it. A row keeps
 * an attempt time exactly while its state is one the queue still asks
 * about. */
const nextAttemptFor = (event: SquareLinkEndEventId): string =>
  // A lease that expired returns the row to the front of the queue; an
  // answer that proved nothing waits out the failure retry.
  event === "lease_expired" ? nowIso() : isoAfter(SQUARE_LINK_RETRY_MS);

/**
 * Move one row on by the event its delete amounted to. A move to `gone` is
 * the row's deletion: no row survives its own ending. Returns whether this
 * worker's write landed — the loser read another runner's outcome.
 */
export const applySquareLinkEndEvent = async (
  row: DueSquareLinkEnd,
  event: SquareLinkEndEventId,
): Promise<boolean> => {
  const to = squareLinkEndMoveTo(row.state, event);
  if (to === "gone") {
    return deleteSquareLinkEnd(row.sessionIndex, row.state, row.claimedAt);
  }
  return moveRowAsRead(row, to, nextAttemptFor(event));
};

/** Delete one row by its index, fenced on the state — and, for a claimed
 * row, the attempt time — it was read with. */
const deleteSquareLinkEnd = async (
  sessionIndex: string,
  state: string,
  claimedAt?: string,
): Promise<boolean> => {
  const result = await execute(
    sql`DELETE FROM square_link_ends
      WHERE session_index = ${sessionIndex} AND state = ${state}
        ${claimedAt === undefined ? sql`` : sql`AND next_attempt_at = ${claimedAt}`}`,
  );
  return result.rowsAffected === 1;
};

/**
 * Take the handle row away when a payment completes. Conditional on
 * `pending`, so a row the task already claimed stays with the task: its own
 * delete refusal will name the paid order. A Square link dies with its first
 * payment either way.
 */
export const forgetSquareLinkEnd = async (sessionId: string): Promise<void> => {
  await deleteSquareLinkEnd(await hmacHash(sessionId), "pending");
};
