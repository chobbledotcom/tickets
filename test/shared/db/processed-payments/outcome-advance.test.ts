/** Advancing a stored session outcome from its conservative shape to its
 * final one — from any process, against racing advances, prunes, and rows
 * that moved somewhere unexpected. */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import type { EnvKeyEncrypted } from "#crypto/sealed.ts";
import { execute, queryOnePrimary } from "#db/client.ts";
import {
  advanceSessionFailure,
  advanceStoredOutcomeOnce,
  parseSessionFailure,
  prepareSessionFailure,
  reserveSession,
} from "#db/processed-payments.ts";
import { sql } from "#db/sql.ts";
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

/** An outcome this process never wrote, so it cannot match the stored one. */
const FOREIGN: StoredPaymentFailure = { error: "Sold out", status: 409 };

const storePendingOutcome = async (sessionId: string): Promise<void> => {
  await reserveSession(sessionId);
  const prepared = await prepareSessionFailure(sessionId, PENDING);
  await execute(prepared.statement);
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
const storedBytes = async (sessionId: string): Promise<EnvKeyEncrypted> => {
  const row = await queryOnePrimary<{ failure_data: EnvKeyEncrypted | "" }>(
    sql`SELECT failure_data FROM processed_payments WHERE payment_session_id = ${sessionId}`,
  );
  if (row === null || row.failure_data === "") {
    throw new Error(`Stored outcome is missing: ${sessionId}`);
  }
  return row.failure_data;
};

/** Store the pending outcome, read its fence bytes, then prune the row so the
 *  fence no longer matches any stored row. */
const storedFenceThenPruned = async (
  sessionId: string,
): Promise<EnvKeyEncrypted> => {
  await storePendingOutcome(sessionId);
  const fence = await storedBytes(sessionId);
  await execute(
    sql`DELETE FROM processed_payments WHERE payment_session_id = ${sessionId}`,
  );
  return fence;
};

/** Store the pending outcome, read its fence bytes, then advance the row to
 *  FINAL so the fence no longer matches the row. */
const storedFenceThenAdvanced = async (
  sessionId: string,
): Promise<EnvKeyEncrypted> => {
  await storePendingOutcome(sessionId);
  const fence = await storedBytes(sessionId);
  await advanceSessionFailure(sessionId, PENDING, FINAL);
  return fence;
};

/** Assert the stored outcome reads back as `expected`, null included. */
const expectStoredOutcome = async (
  sessionId: string,
  expected: StoredPaymentFailure | null,
): Promise<void> => {
  expect(await storedFailure(sessionId)).toEqual(expected);
};

/** Assert the session holds no processed payment row at all. */
const expectNoRow = async (sessionId: string): Promise<void> => {
  expect(await getProcessedPayment(sessionId)).toBeNull();
};

/** Reject an advance that finds an outcome it did not expect to leave behind. */
const expectUnexpectedOutcome = async (
  advance: () => Promise<void>,
  sessionId: string,
): Promise<void> => {
  await expect(advance()).rejects.toThrow(
    `Payment session outcome advanced unexpectedly: ${sessionId}`,
  );
};

/** One advance from the stored pending outcome: the session, any preparation
 *  the case needs, the advance itself, and what it must leave behind. */
type AdvanceCase = {
  readonly advance: (sessionId: string) => Promise<void>;
  readonly expectStored: (sessionId: string) => Promise<void>;
  readonly name: string;
  readonly prepare?: (sessionId: string) => Promise<void>;
  readonly sessionId: string;
};

const advanceCases: readonly AdvanceCase[] = [
  {
    advance: (sessionId) => advanceSessionFailure(sessionId, PENDING, FINAL),
    expectStored: (sessionId) => expectStoredOutcome(sessionId, FINAL),
    name: "advances the exact pending outcome to its final shape",
    prepare: storePendingOutcome,
    sessionId: "advance_session_outcome",
  },
  {
    advance: (sessionId) => advanceSessionFailure(sessionId, PENDING, FINAL),
    expectStored: (sessionId) => expectStoredOutcome(sessionId, FINAL),
    name: "a repeated advance converges on the shape the first one wrote",
    prepare: async (sessionId) => {
      await storePendingOutcome(sessionId);
      await advanceSessionFailure(sessionId, PENDING, FINAL);
    },
    sessionId: "advance_session_again",
  },
  {
    advance: (sessionId) => advanceSessionFailure(sessionId, FINAL, FINAL),
    expectStored: (sessionId) => expectStoredOutcome(sessionId, PENDING),
    name: "identical endpoints change nothing, even on a foreign outcome",
    prepare: storePendingOutcome,
    sessionId: "advance_session_no_move",
  },
  {
    advance: (sessionId) =>
      expectUnexpectedOutcome(
        () => advanceSessionFailure(sessionId, FOREIGN, FINAL),
        sessionId,
      ),
    expectStored: (sessionId) => expectStoredOutcome(sessionId, PENDING),
    name: "refuses to move an outcome it does not recognise",
    prepare: storePendingOutcome,
    sessionId: "advance_session_foreign",
  },
  {
    advance: (sessionId) => advanceSessionFailure(sessionId, PENDING, FINAL),
    expectStored: expectNoRow,
    name: "a pruned row leaves nothing to advance",
    sessionId: "advance_session_gone",
  },
  {
    advance: (sessionId) => advanceSessionFailure(sessionId, PENDING, FINAL),
    expectStored: (sessionId) => expectStoredOutcome(sessionId, null),
    name: "an unresolved reservation is not an outcome to advance",
    prepare: async (sessionId) => {
      await reserveSession(sessionId);
    },
    sessionId: "advance_session_unresolved",
  },
];

/** One stale fence: the session, how its row moves away from the fence the test
 *  presents, the advance that presents it, and what must be left behind. */
type StaleFenceCase = {
  readonly advance: (
    sessionId: string,
    fence: EnvKeyEncrypted,
  ) => Promise<void>;
  readonly expectStored: (sessionId: string) => Promise<void>;
  readonly name: string;
  readonly prepare: (sessionId: string) => Promise<EnvKeyEncrypted>;
  readonly sessionId: string;
};

const staleFenceCases: readonly StaleFenceCase[] = [
  {
    advance: (sessionId, fence) =>
      advanceStoredOutcomeOnce(sessionId, fence, FINAL),
    expectStored: (sessionId) => expectStoredOutcome(sessionId, FINAL),
    name: "a stale fence converges when the row already holds the final shape",
    prepare: storedFenceThenAdvanced,
    sessionId: "advance_session_stale_fence",
  },
  {
    advance: (sessionId, fence) =>
      advanceStoredOutcomeOnce(sessionId, fence, FINAL),
    expectStored: expectNoRow,
    name: "a stale fence finds nothing to check when the row was pruned",
    prepare: storedFenceThenPruned,
    sessionId: "advance_session_fence_pruned",
  },
  {
    advance: (sessionId, fence) =>
      advanceStoredOutcomeOnce(sessionId, fence, FINAL),
    expectStored: (sessionId) => expectStoredOutcome(sessionId, null),
    name: "a stale fence steps aside for a fresh re-reservation",
    prepare: async (sessionId) => {
      const fence = await storedFenceThenPruned(sessionId);
      await reserveSession(sessionId);
      return fence;
    },
    sessionId: "advance_session_fence_rereserved",
  },
  {
    advance: (sessionId, fence) =>
      expectUnexpectedOutcome(
        () =>
          advanceStoredOutcomeOnce(sessionId, fence, {
            error: "A different ending",
            status: 200,
          }),
        sessionId,
      ),
    expectStored: (sessionId) => expectStoredOutcome(sessionId, FINAL),
    name: "a stale fence throws when the row moved somewhere else",
    prepare: storedFenceThenAdvanced,
    sessionId: "advance_session_conflict",
  },
];

describeWithEnv("db > processed payment outcome advance", { db: true }, () => {
  for (const {
    advance,
    expectStored,
    name,
    prepare,
    sessionId,
  } of advanceCases) {
    test(name, async () => {
      await prepare?.(sessionId);

      await advance(sessionId);

      await expectStored(sessionId);
    });
  }

  for (const {
    advance,
    expectStored,
    name,
    prepare,
    sessionId,
  } of staleFenceCases) {
    test(name, async () => {
      const staleFence = await prepare(sessionId);

      await advance(sessionId, staleFence);

      await expectStored(sessionId);
    });
  }
});
