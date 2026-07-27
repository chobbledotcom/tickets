import { expect } from "@std/expect";
import { afterEach, it as test } from "@std/testing/bdd";
import { getDb } from "#shared/db/client.ts";
import { resolvePaymentCaseForResource } from "#shared/db/payments/cases.ts";
import { beginPaymentDecisionAttempt } from "#shared/db/payments/decision-attempts.ts";
import { retryPaymentDecision } from "#shared/db/payments/decisions.ts";
import type { PaymentCaseDecision } from "#shared/db/payments/types.ts";
import { settings } from "#shared/db/settings.ts";
import { resolvePaymentAccount } from "#shared/payment-runtime/account.ts";
import type {
  PaymentOperatorDecision,
  PaymentOperatorSelection,
} from "#shared/payment-state/lifecycle.ts";
import {
  createAcceptedRefundDecision,
  createLegacyAttendeePaymentCase,
  createRetryingPaymentDecision,
} from "#test/shared/payment-runtime/fixtures.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { PAYMENT_TIME, SESSION_RESOURCE } from "./fixtures.ts";

type Attempt = Awaited<ReturnType<typeof beginPaymentDecisionAttempt>>;

/**
 * Save an owner's refund decision, run it once, then change the payment under
 * it and run it again. The second run is the one that has to notice: the quick
 * claim no longer fits, so the slower check works out what moved.
 */
const attemptAfterChange = async (
  change: (paymentId: string, chargeIds: number[]) => Promise<unknown>,
): Promise<{ attempt: Attempt; decision: PaymentCaseDecision }> => {
  const { decision, payment } = await createAcceptedRefundDecision();
  const first = await beginPaymentDecisionAttempt(
    decision.id,
    PAYMENT_TIME + 1,
  );
  if (first.status !== "running") throw new Error("Expected a first run");
  await retryPaymentDecision(decision.id, "Still working", PAYMENT_TIME + 2);
  const charges = await getDb().execute(
    "SELECT id FROM payment_charges WHERE payment_id = ? ORDER BY id",
    [payment.id],
  );
  await change(
    payment.id,
    charges.rows.map((row) => Number(row.id)),
  );
  return {
    attempt: await beginPaymentDecisionAttempt(decision.id, PAYMENT_TIME + 3),
    decision,
  };
};

const updateCharge = (sql: string) => (_paymentId: string, ids: number[]) =>
  getDb().execute(sql, [ids[0]!]);

describeWithEnv("db > payment decision attempts", { db: true }, () => {
  test("sends a decision back for review when a charge changed value", async () => {
    const { attempt } = await attemptAfterChange(
      updateCharge(
        "UPDATE payment_charges SET captured_amount = 500 WHERE id = ?",
      ),
    );

    expect(attempt).toEqual({ status: "review_again" });
  });

  test("sends a decision back for review when a charge is gone", async () => {
    const { attempt } = await attemptAfterChange(
      updateCharge("DELETE FROM payment_charges WHERE id = ?"),
    );

    expect(attempt).toEqual({ status: "review_again" });
  });

  test("sends a decision back for review when the payment moved account", async () => {
    const { attempt } = await attemptAfterChange((paymentId) =>
      getDb().execute(
        "UPDATE payment_sessions SET account_id = 'acct_other' WHERE id = ?",
        [paymentId],
      ),
    );

    expect(attempt).toEqual({ status: "review_again" });
  });

  test("lets a refund that moved on since the review still run", async () => {
    // A retry may find more money already refunded than the owner saw. That is
    // the refund making progress, not the payment changing under them.
    const { attempt } = await attemptAfterChange(
      updateCharge(
        `UPDATE payment_charges
            SET refunded_amount = 400, refund_state = 'partial'
          WHERE id = ?`,
      ),
    );

    expect(attempt.status).toBe("running");
  });

  test("closes a decision whose case someone else already resolved", async () => {
    const { attempt } = await attemptAfterChange((paymentId) =>
      resolvePaymentCaseForResource(
        paymentId,
        SESSION_RESOURCE,
        PAYMENT_TIME + 2,
      ),
    );

    expect(attempt).toEqual({ status: "completed" });
  });

  test("closes the saved decision it sends back for review", async () => {
    const { decision } = await attemptAfterChange(
      updateCharge(
        "UPDATE payment_charges SET captured_amount = 1 WHERE id = ?",
      ),
    );

    const stored = await getDb().execute(
      "SELECT state FROM payment_case_decisions WHERE id = ?",
      [decision.id],
    );
    expect(stored.rows).toEqual([{ state: "completed" }]);
  });
  test("sends a decision back when a refund moved on before it first ran", async () => {
    // The first run has not happened yet, so a refund that moved since the
    // owner looked is a change to the payment, not progress on their decision.
    const { decision, payment } = await createAcceptedRefundDecision();
    const charges = await getDb().execute(
      "SELECT id FROM payment_charges WHERE payment_id = ? ORDER BY id",
      [payment.id],
    );
    await getDb().execute(
      `UPDATE payment_charges
          SET refunded_amount = 400, refund_state = 'partial'
        WHERE id = ?`,
      [Number(charges.rows[0]!.id)],
    );

    expect(
      await beginPaymentDecisionAttempt(decision.id, PAYMENT_TIME + 1),
    ).toEqual({ status: "review_again" });
  });
});

/** An old payment the owner has looked at but not yet assigned a provider. */
const configureSquare = (): void =>
  settings.setForTest({
    square_access_token: "square-token",
    square_location_id: "location-one",
    square_sandbox: true,
  });

const savedLegacyDecision = async (
  selection: PaymentOperatorSelection,
  exact: PaymentOperatorDecision,
): Promise<{ decision: PaymentCaseDecision; paymentId: string }> => {
  const paymentCase = await createLegacyAttendeePaymentCase(
    "square-payment-decision-attempt",
  );
  const decision = await createRetryingPaymentDecision(
    paymentCase,
    selection,
    exact,
  );
  return { decision, paymentId: paymentCase.paymentId };
};

const squareAssignment = async (): Promise<{
  exact: PaymentOperatorDecision;
  selection: PaymentOperatorSelection;
}> => {
  configureSquare();
  const account = await resolvePaymentAccount("square");
  return {
    exact: {
      accountId: account.accountId,
      actorId: 1,
      caseRevision: 0,
      decidedAt: PAYMENT_TIME,
      kind: "assign_provider",
      mode: account.mode,
      provider: "square",
      read: { status: "missing" },
      reason: "Checked the stored payment facts",
    },
    selection: { ...account, kind: "assign_provider" },
  };
};

/** Save an owner's "use this Square account" decision on an old payment, run
 *  it once, then change what it looked at and run it again. */
const legacyAttemptAfterChange = async (
  change: (paymentId: string) => Promise<unknown>,
): Promise<Attempt> => {
  const { exact, selection } = await squareAssignment();
  const { decision, paymentId } = await savedLegacyDecision(selection, {
    ...exact,
    caseRevision: 1,
  });
  await change(paymentId);
  return beginPaymentDecisionAttempt(decision.id, PAYMENT_TIME + 3);
};

describeWithEnv("db > old payment decision attempts", { db: true }, () => {
  afterEach(() => settings.clearTestOverrides());

  test("runs again while the old payment still looks the way it did", async () => {
    const attempt = await legacyAttemptAfterChange(() => Promise.resolve());

    expect(attempt.status).toBe("running");
  });

  test("sends the decision back when the old charge has gone", async () => {
    // This decision saw no provider record, so a charge that no longer looks
    // the way the owner saw it leaves nothing to match on.
    const attempt = await legacyAttemptAfterChange((paymentId) =>
      getDb().execute("DELETE FROM payment_charges WHERE payment_id = ?", [
        paymentId,
      ]),
    );

    expect(attempt).toEqual({ status: "review_again" });
  });

  test("sends the decision back once another account claimed the payment", async () => {
    const attempt = await legacyAttemptAfterChange((paymentId) =>
      getDb().execute(
        `UPDATE payment_sessions
            SET provider = 'stripe', mode = 'test', account_id = 'acct_other'
          WHERE id = ?`,
        [paymentId],
      ),
    );

    expect(attempt).toEqual({ status: "review_again" });
  });
});
