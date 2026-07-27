import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { logActivity } from "#shared/db/activityLog.ts";
import { getDb } from "#shared/db/client.ts";
import { requirePaymentSessionClaim } from "#shared/db/payments/claims.ts";
import { runPaymentCompletionDbEffect } from "#shared/db/payments/completion-effects.ts";
import { PAYMENT_ID } from "#test/shared/db/payments/fixtures.ts";
import { createPendingPayment } from "#test/shared/payment-runtime/fixtures.ts";
import { describeWithEnv } from "#test-utils/db.ts";

const storedCounts = async (): Promise<{
  activities: number;
  receipts: number;
}> => {
  const [activity, receipt] = await Promise.all([
    getDb().execute("SELECT COUNT(*) AS count FROM activity_log"),
    getDb().execute("SELECT COUNT(*) AS count FROM payment_completion_effects"),
  ]);
  return {
    activities: Number(activity.rows[0]?.count),
    receipts: Number(receipt.rows[0]?.count),
  };
};

describeWithEnv("payment completion database effects", { db: true }, () => {
  test("stores an activity and its receipt exactly once", async () => {
    await createPendingPayment();
    const claim = await requirePaymentSessionClaim(PAYMENT_ID, 60_000);
    let attempts = 0;
    const run = () =>
      runPaymentCompletionDbEffect(
        claim,
        "registration_activity",
        async (transaction) => {
          attempts += 1;
          await logActivity(
            "Payment completion activity",
            null,
            null,
            transaction,
          );
          return null;
        },
      );

    await run();
    await run();

    expect(attempts).toBe(1);
    expect(await storedCounts()).toEqual({ activities: 1, receipts: 1 });
  });

  test("rolls back both the domain write and receipt on failure", async () => {
    await createPendingPayment();
    const claim = await requirePaymentSessionClaim(PAYMENT_ID, 60_000);
    let fail = true;
    const run = () =>
      runPaymentCompletionDbEffect(
        claim,
        "refund_activity",
        async (transaction) => {
          await logActivity(
            "Refund completion activity",
            null,
            null,
            transaction,
          );
          if (fail) throw new Error("activity interrupted");
          return null;
        },
      );

    await expect(run()).rejects.toThrow("activity interrupted");
    expect(await storedCounts()).toEqual({ activities: 0, receipts: 0 });
    fail = false;
    await run();

    expect(await storedCounts()).toEqual({ activities: 1, receipts: 1 });
  });

  test("rejects a database effect from a stale claim", async () => {
    await createPendingPayment();
    const stale = await requirePaymentSessionClaim(PAYMENT_ID, 60_000);
    await getDb().execute(
      "UPDATE payment_sessions SET lease_expires_at = 0 WHERE id = ?",
      [PAYMENT_ID],
    );
    await requirePaymentSessionClaim(PAYMENT_ID, 60_000);

    await expect(
      runPaymentCompletionDbEffect(stale, "answers", () =>
        Promise.resolve(null),
      ),
    ).rejects.toThrow(`Lost payment session lease for ${PAYMENT_ID}`);
    expect(await storedCounts()).toEqual({ activities: 0, receipts: 0 });
  });
});
