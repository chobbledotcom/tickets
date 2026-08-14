import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { execute } from "#shared/db/client.ts";
import {
  type PreparedSessionFailure,
  parseSessionFailure,
  prepareSessionFailure,
  reserveSession,
} from "#shared/db/processed-payments.ts";
import type { StoredPaymentFailure } from "#shared/payment/row-state.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { getProcessedPayment } from "#test-utils/processed-payments.ts";

const PENDING: StoredPaymentFailure = {
  error: "Your refund is being arranged",
  status: 200,
};

const prepareStoredFailure = async (
  sessionId: string,
): Promise<PreparedSessionFailure> => {
  await reserveSession(sessionId);
  const prepared = await prepareSessionFailure(sessionId, PENDING);
  await execute(prepared.statement.sql, prepared.statement.args);
  return prepared;
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

describeWithEnv(
  "db > processed payment failure replacement",
  { db: true },
  () => {
    test("replaces its exact pending failure with the completed result", async () => {
      const sessionId = "replace_session_failure";
      const prepared = await prepareStoredFailure(sessionId);
      const completed: StoredPaymentFailure = {
        error: "Your payment was refunded",
        refunded: true,
        status: 200,
      };

      await prepared.replace(completed);

      expect(await storedFailure(sessionId)).toEqual(completed);
    });

    test("rejects a replacement after another result won the race", async () => {
      const sessionId = "race_session_failure";
      const prepared = await prepareStoredFailure(sessionId);
      const winner: StoredPaymentFailure = {
        error: "The other request finished",
        refunded: true,
        status: 200,
      };
      await prepared.replace(winner);

      await expect(
        prepared.replace({ error: "This request was stale", status: 409 }),
      ).rejects.toThrow(
        `Payment session failure changed before completion: ${sessionId}`,
      );
      expect(await storedFailure(sessionId)).toEqual(winner);
    });
  },
);
