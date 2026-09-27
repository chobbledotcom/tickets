import {
  openSquareCheckoutIdentity,
  type StagedCheckoutRow,
} from "#db/checkout-pending-answers.ts";
import { execute, queryAll, queryOne } from "#db/client.ts";
import { errorMessage } from "#shared/error-message.ts";
import { ErrorCode, logError } from "#shared/logger.ts";
import { squareApi } from "#shared/square/api.ts";
import type { SquareClient } from "#shared/square/client.ts";

/** A small batch bounds provider calls and leaves other maintenance work room. */
export const SQUARE_CANCELLATION_BATCH = 4;
const RETRY_MS = 30 * 60 * 1000;
const LEASE_MS = 5 * 60 * 1000;

type SquareCandidate = StagedCheckoutRow;

const releaseClaim = async (index: string, token: string): Promise<void> => {
  await execute(
    `UPDATE checkout_pending_answers
       SET state = 'open', claim_token = '', next_check_at = ?
     WHERE session_index = ? AND state = 'cancelling' AND claim_token = ?`,
    [new Date(Date.now() + RETRY_MS).toISOString(), index, token],
  );
};

const claimCandidate = async (
  row: SquareCandidate,
  token: string,
): Promise<boolean> => {
  const now = new Date().toISOString();
  const claim = await execute(
    `UPDATE checkout_pending_answers
       SET state = 'cancelling', claim_token = ?, next_check_at = ?
     WHERE session_index = ? AND provider = 'square'
       AND state IN ('open', 'cancelling') AND next_check_at <= ?`,
    [
      token,
      new Date(Date.now() + LEASE_MS).toISOString(),
      row.session_index,
      now,
    ],
  );
  return claim.rowsAffected === 1;
};

/** The cancelled order is authoritative only while no local payment owns it. */
const cancelCandidate = async (
  row: SquareCandidate,
  client: SquareClient,
): Promise<void> => {
  const token = crypto.randomUUID();
  if (!await claimCandidate(row, token)) return;
  try {
    const { sessionId, linkId } = await openSquareCheckoutIdentity(row);
    const local = await queryOne<{ failure_data: string }>(
      "SELECT failure_data FROM processed_payments WHERE payment_session_id = ?",
      [sessionId],
    );
    if (local !== null) {
      // A failed payment is terminal, but an in-flight reservation or paid
      // booking must win over this worker. Terminal cleanup runs separately.
      return;
    }
    const deleted = await client.checkout.paymentLinks.delete({ id: linkId });
    if (deleted.id !== linkId || deleted.cancelled_order_id !== sessionId) {
      throw new Error("Square cancelled a different checkout");
    }
    const observed = (await client.orders.get({ orderId: sessionId })).order;
    if (
      observed?.id !== sessionId || observed.state !== "CANCELED" ||
      (observed.tenders?.length ?? 0) !== 0
    ) {
      // A missing/paid/unknown order is not evidence that the link is safe.
      return;
    }
    await execute(
      `DELETE FROM checkout_pending_answers
       WHERE session_index = ? AND state = 'cancelling' AND claim_token = ?
         AND NOT EXISTS (
           SELECT 1 FROM processed_payments WHERE payment_session_id = ?
         )`,
      [row.session_index, token, sessionId],
    );
  } finally {
    // A network error or a paid/unknown outcome never destroys staged text.
    await releaseClaim(row.session_index, token);
  }
};

/** Reconcile old Square links; true asks the scheduler for another batch. */
export const runSquareCheckoutCancellation = async (): Promise<boolean> => {
  const rows = await queryAll<SquareCandidate>(
    `SELECT session_index, sealed, wrapped_key
       FROM checkout_pending_answers
      WHERE provider = 'square' AND state IN ('open', 'cancelling')
        AND next_check_at <= ?
      ORDER BY next_check_at, session_index LIMIT ?`,
    [new Date().toISOString(), SQUARE_CANCELLATION_BATCH],
  );
  if (rows.length === 0) return false;
  const client = await squareApi.getSquareClient();
  if (client === null) throw new Error("Square cancellation needs a Square client");
  for (const row of rows) {
    try {
      await cancelCandidate(row, client);
    } catch (error) {
      logError({
        code: ErrorCode.PAYMENT_SESSION,
        detail: `Square cancellation failed for ${row.session_index}: ${errorMessage(error)}`,
      });
    }
  }
  return rows.length === SQUARE_CANCELLATION_BATCH;
};
