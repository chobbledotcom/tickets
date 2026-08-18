// jscpd:ignore-start
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { queryAll, queryOne } from "#shared/db/client.ts";
import { runSumupRecovery } from "#shared/sumup/recovery-run.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { withDbFault } from "#test-utils/db-fault.ts";
import {
  makeSumupCheckoutDue,
  stageSignedSumupCheckout,
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

const countOf = async (sql: string): Promise<number> =>
  (await queryAll<{ n: number }>(sql))[0]?.n ?? 0;

const stateOf = async (): Promise<string> => {
  const row = await queryOne<{ recovery_state: string }>(
    "SELECT recovery_state FROM sumup_checkouts WHERE sumup_id = ?",
    [CHECKOUT_ID],
  );
  if (!row) throw new Error("The staged checkout is gone");
  return row.recovery_state;
};

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
      expect(await countOf("SELECT COUNT(*) AS n FROM attendees")).toBe(1);
      expect(await stateOf()).toBe("waiting");

      await runSumupRecovery();

      expect(await stateOf()).toBe("finished");
      // The replay booked nobody a second time.
      expect(await countOf("SELECT COUNT(*) AS n FROM attendees")).toBe(1);
      expect(
        await countOf("SELECT COUNT(*) AS n FROM processed_payments"),
      ).toBe(1);
    } finally {
      restore.restore();
    }
  });
});
