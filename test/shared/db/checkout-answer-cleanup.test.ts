/** The terminal checkout sweep: a failed payment's staged answers are durable
 * cleanup work, and a finalized booking's staging closes loudly after it has
 * outlived every replay. */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { runTerminalCheckoutCleanup } from "#db/checkout-answer-cleanup.ts";
import {
  sessionWorkIndex,
  stageCheckoutAnswers,
} from "#db/checkout-pending-answers.ts";
import { execute, queryOne } from "#db/client.ts";
import { describeWithEnv } from "#test-utils/db.ts";

const OLD_FINALIZED = "2026-08-01T00:00:00.000Z";
const NEW_FINALIZED = "2099-01-01T00:00:00.000Z";

const stagedRow = async (sessionId: string): Promise<boolean> =>
  (await queryOne<{ session_index: string }>(
    "SELECT session_index FROM checkout_pending_answers WHERE session_index = ?",
    [await sessionWorkIndex(sessionId)],
  )) !== null;

const recordFailure = async (
  sessionId: string,
  processedAt: string,
): Promise<void> => {
  await stageCheckoutAnswers(sessionId, { "7": "text" });
  await execute(
    `INSERT INTO processed_payments
       (payment_session_id, attendee_id, processed_at, failure_data)
     VALUES (?, NULL, ?, 'enc:1:x:y')`,
    [sessionId, processedAt],
  );
};

const recordFinalized = async (
  sessionId: string,
  processedAt: string,
): Promise<void> => {
  await stageCheckoutAnswers(sessionId, { "7": "text" });
  await execute(
    `INSERT INTO processed_payments
       (payment_session_id, attendee_id, processed_at, ticket_tokens)
     VALUES (?, 910020, ?, '')`,
    [sessionId, processedAt],
  );
};

describeWithEnv("terminal checkout cleanup", { db: true }, () => {
  test("removes a failed payment's staged answers", async () => {
    await recordFailure("cs_failed_payment", NEW_FINALIZED);

    const result = await runTerminalCheckoutCleanup(null);

    expect(result.fullBatch).toBe(false);
    expect(await stagedRow("cs_failed_payment")).toBe(false);
  });

  test("closes a finalized booking's staging once it is old", async () => {
    await recordFinalized("cs_old_finalized", OLD_FINALIZED);

    await runTerminalCheckoutCleanup(null);

    expect(await stagedRow("cs_old_finalized")).toBe(false);
  });

  test("keeps a recently finalized booking's staging for its replays", async () => {
    await recordFinalized("cs_new_finalized", NEW_FINALIZED);

    await runTerminalCheckoutCleanup(null);

    expect(await stagedRow("cs_new_finalized")).toBe(true);
  });

  test("resumes from its checkpoint across batches", async () => {
    await recordFailure("cs_checkpoint_one", NEW_FINALIZED);
    await recordFailure("cs_checkpoint_two", NEW_FINALIZED);

    const first = await runTerminalCheckoutCleanup(null);

    expect(first.fullBatch).toBe(false);
    // A finished sweep resets its checkpoint; both rows are gone.
    expect(await stagedRow("cs_checkpoint_one")).toBe(false);
    expect(await stagedRow("cs_checkpoint_two")).toBe(false);
  });

  test("refuses an invalid checkpoint", () => {
    expect(runTerminalCheckoutCleanup("not-a-number")).rejects.toThrow(
      "Invalid terminal checkout cleanup checkpoint",
    );
  });
});
