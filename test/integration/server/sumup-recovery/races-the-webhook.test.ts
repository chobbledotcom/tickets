// jscpd:ignore-start
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { runSumupRecovery } from "#shared/sumup/recovery-run.ts";
import { tableRowCount } from "#test-utils/db/migration-test-helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { mockWebhookRequest } from "#test-utils/mocks.ts";
import {
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

describeWithEnv(
  "server > SumUp recovery races the webhook",
  { db: true },
  () => {
    /** Run the callback and the recovery check at the same moment, against a
     * checkout SumUp says was paid. */
    const runBothAtOnce = async (): Promise<void> => {
      const { reference } = await stageSignedSumupCheckout(CHECKOUT_ID);
      await makeSumupCheckoutDue(CHECKOUT_ID);
      const restore = withSumupCheckoutStatus(reference, "PAID", "txn_race");
      try {
        await Promise.all([callback(), runSumupRecovery()]);
      } finally {
        restore.restore();
      }
    };

    test("books exactly once when the callback and the check run together", async () => {
      // The recovery task exists because the callback can be lost. When it is
      // not lost, both reach the same engine at the same moment — and the
      // buyer must still get one ticket and one set of money records.
      await runBothAtOnce();

      expect(await tableRowCount("attendees")).toBe(1);
      // One reservation, so neither side booked a second time.
      expect(await tableRowCount("processed_payments")).toBe(1);
    });

    test("never leaves the row claiming money is owed for a booked ticket", async () => {
      await runBothAtOnce();

      expect((await sumupRecoveryRow(CHECKOUT_ID)).state).not.toBe("owed");
    });
  },
);
