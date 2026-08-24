// jscpd:ignore-start
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { execute } from "#db/client.ts";
import { runSumupRecovery } from "#shared/sumup/recovery-run.ts";
import { sumupApi } from "#shared/sumup.ts";
import { tableRowCount } from "#test-utils/db/migration-test-helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  expectBookedExactlyOnce,
  makeSumupCheckoutDue,
  stageSignedSumupCheckout,
  sumupRecoveryRow,
  withSumupCheckoutStatus,
} from "#test-utils/sumup.ts";

// jscpd:ignore-end

describeWithEnv("server > SumUp recovery", { db: true }, () => {
  /** Stage a real checkout the way production does, then make it due. */
  const stageDueCheckout = async (checkoutId: string): Promise<string> => {
    const { reference } = await stageSignedSumupCheckout(checkoutId);
    await makeSumupCheckoutDue(checkoutId);
    return reference;
  };

  const readCheckout = (
    reference: string,
    status: "EXPIRED" | "FAILED" | "PAID" | "PENDING",
  ) => withSumupCheckoutStatus(reference, status, "txn_recovered");

  test("books a paid checkout whose callback never arrived", async () => {
    // The whole point of the feature: SumUp took the money, the one callback
    // was lost, and nothing else would ever have asked.
    const reference = await stageDueCheckout("co_lost");
    const restore = readCheckout(reference, "PAID");
    try {
      expect(await tableRowCount("attendees")).toBe(0);

      await runSumupRecovery();

      expect(await tableRowCount("attendees")).toBe(1);
      const row = await sumupRecoveryRow("co_lost");
      expect(row.state).toBe("finished");
      // Finished rows are never asked about again.
      expect(row.nextCheckAt).toBeNull();
    } finally {
      restore.restore();
    }
  });

  test("books it exactly once when the check runs twice", async () => {
    const reference = await stageDueCheckout("co_twice");
    const restore = readCheckout(reference, "PAID");
    try {
      await runSumupRecovery();
      // The row is finished, so the second run does not even select it.
      await execute(
        "UPDATE sumup_checkouts SET recovery_state = 'waiting', next_check_at = ? WHERE sumup_id = ?",
        ["2000-01-01T00:00:00.000Z", "co_twice"],
      );
      await runSumupRecovery();

      // One ticket and one payment reservation, however many times the work
      // ran: the reservation row is the key the engine reserves against.
      await expectBookedExactlyOnce();
      expect((await sumupRecoveryRow("co_twice")).state).toBe("finished");
    } finally {
      restore.restore();
    }
  });

  test("closes a checkout SumUp says was never paid", async () => {
    const reference = await stageDueCheckout("co_expired");
    const restore = readCheckout(reference, "EXPIRED");
    try {
      await runSumupRecovery();

      expect(await tableRowCount("attendees")).toBe(0);
      const row = await sumupRecoveryRow("co_expired");
      expect(row.state).toBe("unpaid");
      expect(row.nextCheckAt).toBeNull();
    } finally {
      restore.restore();
    }
  });

  test("asks again about a checkout nobody has paid yet", async () => {
    const reference = await stageDueCheckout("co_pending");
    const restore = readCheckout(reference, "PENDING");
    try {
      await runSumupRecovery();

      const row = await sumupRecoveryRow("co_pending");
      expect(row.state).toBe("waiting");
      // Still open, and moved out of the way of rows due before it: the next
      // check is hours ahead, not the moment in the past it was given.
      const dueAgainAt = Date.parse(row.nextCheckAt ?? "");
      expect(Number.isNaN(dueAgainAt)).toBe(false);
      expect(dueAgainAt).toBeGreaterThan(Date.now());
    } finally {
      restore.restore();
    }
  });

  test("keeps asking when SumUp cannot answer, and never calls it unpaid", async () => {
    // An outage must never be read as "the customer did not pay" — that is
    // the reading that would delete a paid checkout.
    await stageDueCheckout("co_outage");
    const restore = stub(sumupApi, "readCheckoutById", () =>
      Promise.resolve({
        reason: "provider_error" as const,
        status: "unavailable" as const,
      }),
    );
    try {
      await runSumupRecovery();

      expect((await sumupRecoveryRow("co_outage")).state).toBe("waiting");
    } finally {
      restore.restore();
    }
  });

  test("leaves a row alone when another runner answered it first", async () => {
    const reference = await stageDueCheckout("co_raced");
    const restore = readCheckout(reference, "PAID");
    try {
      const { getDueSumupCheckouts, applySumupRecoveryEvent } = await import(
        "#db/sumup-recovery.ts"
      );
      const due = await getDueSumupCheckouts();
      const seen = due[0];
      if (!seen) throw new Error("The staged checkout was not due");
      // Another runner answers the row between our read and our write.
      await execute(
        "UPDATE sumup_checkouts SET recovery_state = 'finished', next_check_at = NULL WHERE sumup_id = ?",
        ["co_raced"],
      );

      expect(await applySumupRecoveryEvent(seen, "read_pending")).toBe(false);
      // The winner's answer stands.
      expect((await sumupRecoveryRow("co_raced")).state).toBe("finished");
    } finally {
      restore.restore();
    }
  });
});
