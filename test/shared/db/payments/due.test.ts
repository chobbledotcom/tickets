import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { getDb } from "#shared/db/client.ts";
import { claimPaymentSession } from "#shared/db/payments/claims.ts";
import {
  getDuePaymentSessionsPrimary,
  PAYMENT_RECONCILIATION_PAGE_SIZE,
} from "#shared/db/payments/due.ts";
import { createPaymentSession } from "#shared/db/payments/sessions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { PAYMENT_TIME, paymentSessionInput } from "./fixtures.ts";

const makeDue = async (id: string, nextReconcileAt: number): Promise<void> => {
  await createPaymentSession(paymentSessionInput(id), PAYMENT_TIME);
  await getDb().execute(
    `UPDATE payment_sessions
        SET state = 'pending', next_reconcile_at = ?
      WHERE id = ?`,
    [nextReconcileAt, id],
  );
};

describeWithEnv("db > payments > due reconciliation", { db: true }, () => {
  test("orders a fixed primary page by due time and id", async () => {
    await makeDue("payment-b", 0);
    await makeDue("payment-a", 0);
    await makeDue("payment-earlier", 1);
    const client = getDb();
    const batch = client.batch.bind(client);
    const modes: string[] = [];
    using _batch = stub(client, "batch", (statements, mode) => {
      modes.push(mode ?? "");
      return batch(statements, mode);
    });

    expect(PAYMENT_RECONCILIATION_PAGE_SIZE).toBe(1);
    expect(await getDuePaymentSessionsPrimary()).toEqual([
      {
        id: "payment-a",
        nextReconcileAt: 0,
        provider: "stripe",
        state: "pending",
      },
    ]);
    expect(modes).toEqual(["write"]);
  });

  test("excludes a live lease and admits it after expiry", async () => {
    await makeDue("payment-a", 0);
    await makeDue("payment-b", 0);
    expect(await claimPaymentSession("payment-a", 60_000)).not.toBeNull();

    expect((await getDuePaymentSessionsPrimary()).map(({ id }) => id)).toEqual([
      "payment-b",
    ]);
    await getDb().execute(
      "UPDATE payment_sessions SET lease_expires_at = 0 WHERE id = ?",
      ["payment-a"],
    );

    expect((await getDuePaymentSessionsPrimary()).map(({ id }) => id)).toEqual([
      "payment-a",
    ]);
  });

  test("selects only states with durable work to resume", async () => {
    await createPaymentSession(
      paymentSessionInput("created-without-input", null),
    );
    await makeDue("failed-payment", 0);
    await getDb().execute(
      "UPDATE payment_sessions SET state = 'failed' WHERE id = ?",
      ["failed-payment"],
    );

    expect(await getDuePaymentSessionsPrimary()).toEqual([]);
  });
});
