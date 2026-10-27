// jscpd:ignore-start
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { queryAll } from "#db/client.ts";
import { handleRequest } from "#routes";
import { runSumupRecovery } from "#shared/sumup/recovery-run.ts";
import { tableRowCount } from "#test-utils/db/migration-test-helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { mockWebhookRequest } from "#test-utils/mocks.ts";
import {
  expectBookedExactlyOnce,
  makeSumupCheckoutDue,
  stageSignedSumupCheckout,
  sumupRecoveryRow,
  withSumupCheckoutStatus,
} from "#test-utils/sumup.ts";

// jscpd:ignore-end

const CHECKOUT_ID = "co_race";

const callback = () =>
  handleRequest(
    mockWebhookRequest({
      event_type: "CHECKOUT_STATUS_CHANGED",
      id: CHECKOUT_ID,
    }),
  );

/** The buyer's return to /payment/success for the checkout they paid. */
const returnToSuccessPage = (reference: string): Promise<Response> =>
  handleRequest(
    new Request(`https://example.com/payment/success?session_id=${reference}`),
  );

/** Every distinct event group in the ledger. The payment's own legs share
 * one group, so a second group means the ledger posted a second order. */
const ledgerEventGroups = async (): Promise<string[]> => {
  const rows = await queryAll<{ event_group: string }>(
    "SELECT DISTINCT event_group FROM transfers",
  );
  return rows.map((row) => row.event_group);
};

describeWithEnv(
  "server > SumUp recovery races the webhook",
  { db: true },
  () => {
    /** Stage a paid checkout, then run the callback, the recovery check, and
     * every attempt given at the same moment. Each attempt receives the
     * checkout's reference, and the attempts' responses come back. */
    const runAllAtOnce = async (
      attempts: readonly ((reference: string) => Promise<Response>)[],
    ): Promise<Response[]> => {
      const { reference } = await stageSignedSumupCheckout(CHECKOUT_ID);
      await makeSumupCheckoutDue(CHECKOUT_ID);
      const restore = withSumupCheckoutStatus(reference, "PAID", "txn_race");
      const attemptResponses = attempts.map((attempt) => attempt(reference));
      try {
        await Promise.all([
          callback(),
          runSumupRecovery(),
          ...attemptResponses,
        ]);
        // The attempts raced above; this second await only reads their
        // settled answers.
        return await Promise.all(attemptResponses);
      } finally {
        restore.restore();
      }
    };

    test("books exactly once when the callback and the check run together", async () => {
      // The recovery task exists because the callback can be lost. When it is
      // not lost, both reach the same engine at the same moment — and the
      // buyer must still get one ticket and one set of money records.
      await runAllAtOnce([]);

      expect(await tableRowCount("attendees")).toBe(1);
      // One reservation, so neither side booked a second time.
      expect(await tableRowCount("processed_payments")).toBe(1);
      // The payment's legs all carry its one event group, so a second group
      // means a second order reached the ledger.
      expect(await ledgerEventGroups()).toHaveLength(1);
    });

    test("never leaves the row claiming money is owed for a booked ticket", async () => {
      await runAllAtOnce([]);

      expect((await sumupRecoveryRow(CHECKOUT_ID)).state).not.toBe("owed");
    });

    test("books exactly once when the callback, the buyer's return, and the check run together", async () => {
      // All three roads to the same payment can fire at once: the provider's
      // callback, the buyer's browser, and the maintenance check. Each
      // reaches the same engine, and together they must still leave one
      // ticket and one set of money records.
      const [returnResponse] = await runAllAtOnce([returnToSuccessPage]);

      // The buyer's page must have reached the payment engine: it answers
      // with the ticket redirect, the rendered page, or the 409 hold for a
      // racer that is still working. A route miss or a refused callback
      // would leave the race at two, not three.
      expect([200, 302, 409]).toContain(returnResponse?.status);
      await expectBookedExactlyOnce();
      // One event group, so no attempt booked the order a second time.
      expect(await ledgerEventGroups()).toHaveLength(1);
    });
  },
);
