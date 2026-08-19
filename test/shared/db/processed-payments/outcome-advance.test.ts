/** Advancing a stored session outcome from its conservative shape to its
 * final one — from any process, against racing advances, prunes, and rows
 * that moved somewhere unexpected. */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { execute } from "#db/client.ts";
import {
  advanceSessionFailure,
  advanceStoredOutcomeOnce,
  parseSessionFailure,
  prepareSessionFailure,
  reserveSession,
} from "#db/processed-payments.ts";
import type { StoredPaymentFailure } from "#payment/row-state.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { getProcessedPayment } from "#test-utils/processed-payments.ts";

const PENDING: StoredPaymentFailure = {
  completion: { code: "capacity_full" },
  error: "Your refund is being arranged",
  status: 200,
};

const FINAL: StoredPaymentFailure = {
  completion: { code: "capacity_full" },
  error: "Your payment was refunded",
  refunded: true,
  status: 200,
};

const storePendingOutcome = async (sessionId: string): Promise<void> => {
  await reserveSession(sessionId);
  const prepared = await prepareSessionFailure(sessionId, PENDING);
  await execute(prepared.statement.sql, prepared.statement.args);
};

const storedFailure = async (
  sessionId: string,
): Promise<StoredPaymentFailure | null> => {
  const row = await getProcessedPayment(sessionId);
  if (row === null) {
    throw new Error(`Processed payment is missing: ${sessionId}`);
  }
  return await parseSessionFailure(row.failure_data);
};

/** The exact encrypted bytes the session row holds right now. */
const storedBytes = async (sessionId: string) => {
  const row = await getProcessedPayment(sessionId);
  if (row === null || row.failure_data === "") {
    throw new Error(`Stored outcome is missing: ${sessionId}`);
  }
  return row.failure_data;
};

describeWithEnv("db > processed payment outcome advance", { db: true }, () => {
  test("advances the exact pending outcome to its final shape", async () => {
    const sessionId = "advance_session_outcome";
    await storePendingOutcome(sessionId);

    await advanceSessionFailure(sessionId, PENDING, FINAL);

    expect(await storedFailure(sessionId)).toEqual(FINAL);
  });

  test("a repeated advance converges on the shape the first one wrote", async () => {
    const sessionId = "advance_session_again";
    await storePendingOutcome(sessionId);
    await advanceSessionFailure(sessionId, PENDING, FINAL);

    await advanceSessionFailure(sessionId, PENDING, FINAL);

    expect(await storedFailure(sessionId)).toEqual(FINAL);
  });

  test("identical endpoints change nothing, even on a foreign outcome", async () => {
    const sessionId = "advance_session_no_move";
    await storePendingOutcome(sessionId);

    await advanceSessionFailure(sessionId, FINAL, FINAL);

    expect(await storedFailure(sessionId)).toEqual(PENDING);
  });

  test("refuses to move an outcome it does not recognise", async () => {
    const sessionId = "advance_session_foreign";
    await storePendingOutcome(sessionId);
    const foreign: StoredPaymentFailure = { error: "Sold out", status: 409 };

    await expect(
      advanceSessionFailure(sessionId, foreign, FINAL),
    ).rejects.toThrow(
      `Payment session outcome advanced unexpectedly: ${sessionId}`,
    );
    expect(await storedFailure(sessionId)).toEqual(PENDING);
  });

  test("a pruned row leaves nothing to advance", async () => {
    await advanceSessionFailure("advance_session_gone", PENDING, FINAL);
  });

  test("an unresolved reservation is not an outcome to advance", async () => {
    const sessionId = "advance_session_unresolved";
    await reserveSession(sessionId);

    await advanceSessionFailure(sessionId, PENDING, FINAL);

    expect(await storedFailure(sessionId)).toBeNull();
  });

  test("a stale fence converges when the row already holds the final shape", async () => {
    const sessionId = "advance_session_stale_fence";
    await storePendingOutcome(sessionId);
    const staleFence = await storedBytes(sessionId);
    await advanceSessionFailure(sessionId, PENDING, FINAL);

    await advanceStoredOutcomeOnce(sessionId, staleFence, FINAL);

    expect(await storedFailure(sessionId)).toEqual(FINAL);
  });

  test("a stale fence finds nothing to check when the row was pruned", async () => {
    const sessionId = "advance_session_fence_pruned";
    await storePendingOutcome(sessionId);
    const staleFence = await storedBytes(sessionId);
    await execute(
      "DELETE FROM processed_payments WHERE payment_session_id = ?",
      [sessionId],
    );

    await advanceStoredOutcomeOnce(sessionId, staleFence, FINAL);

    expect(await getProcessedPayment(sessionId)).toBeNull();
  });

  test("a stale fence steps aside for a fresh re-reservation", async () => {
    const sessionId = "advance_session_fence_rereserved";
    await storePendingOutcome(sessionId);
    const staleFence = await storedBytes(sessionId);
    await execute(
      "DELETE FROM processed_payments WHERE payment_session_id = ?",
      [sessionId],
    );
    await reserveSession(sessionId);

    await advanceStoredOutcomeOnce(sessionId, staleFence, FINAL);

    expect(await storedFailure(sessionId)).toBeNull();
  });

  test("a stale fence throws when the row moved somewhere else", async () => {
    const sessionId = "advance_session_conflict";
    await storePendingOutcome(sessionId);
    const staleFence = await storedBytes(sessionId);
    await advanceSessionFailure(sessionId, PENDING, FINAL);

    await expect(
      advanceStoredOutcomeOnce(sessionId, staleFence, {
        error: "A different ending",
        status: 200,
      }),
    ).rejects.toThrow(
      `Payment session outcome advanced unexpectedly: ${sessionId}`,
    );
    expect(await storedFailure(sessionId)).toEqual(FINAL);
  });
});
