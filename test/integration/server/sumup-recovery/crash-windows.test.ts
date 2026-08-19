// jscpd:ignore-start
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { runSumupRecovery } from "#shared/sumup/recovery-run.ts";
import { tableRowCount } from "#test-utils/db/migration-test-helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { withDbFault } from "#test-utils/db-fault.ts";
import {
  expectBookedExactlyOnce,
  makeSumupCheckoutDue,
  stageSignedSumupCheckout,
  sumupRecoveryRow,
  withSumupCheckoutStatus,
} from "#test-utils/sumup.ts";

// jscpd:ignore-end

const CHECKOUT_ID = "co_crash";
const STATE_FAULT = "test_sumup_recovery_state_fault";

/** The recovery state write refuses; every other write still works. This is
 * the one window the machine cannot cover with an edge — the booking has
 * committed and the row has not been moved. */
const withStateWriteFault = <T>(body: () => Promise<T>): Promise<T> =>
  withDbFault(
    `CREATE TRIGGER ${STATE_FAULT}
      BEFORE UPDATE ON sumup_checkouts
      WHEN NEW.recovery_state = 'finished'
      BEGIN
        SELECT RAISE(ABORT, 'recovery state write unavailable');
      END`,
    STATE_FAULT,
    body,
  );

describeWithEnv("server > SumUp recovery crash windows", { db: true }, () => {
  test("finishes the row on the next check when the state write failed", async () => {
    // The booking commits and then the row cannot be moved. Nothing is lost:
    // the row is still due, the next check replays the same answer, and the
    // buyer is not booked twice.
    const { reference } = await stageSignedSumupCheckout(CHECKOUT_ID);
    await makeSumupCheckoutDue(CHECKOUT_ID);
    const restore = withSumupCheckoutStatus(reference, "PAID", "txn_crash");
    try {
      await withStateWriteFault(async () => {
        await expect(runSumupRecovery()).rejects.toThrow();
      });

      // The booking is already made, but the row still says it is waiting.
      expect(await tableRowCount("attendees")).toBe(1);
      expect((await sumupRecoveryRow(CHECKOUT_ID)).state).toBe("waiting");

      await runSumupRecovery();

      expect((await sumupRecoveryRow(CHECKOUT_ID)).state).toBe("finished");
      // The replay booked nobody a second time.
      await expectBookedExactlyOnce();
    } finally {
      restore.restore();
    }
  });
});
