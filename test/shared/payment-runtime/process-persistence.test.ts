import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import type { EnvKeyEncrypted } from "#shared/crypto/sealed.ts";
import { getDb, resultRows } from "#shared/db/client.ts";
import { recordPaymentCase } from "#shared/db/payments/cases.ts";
import {
  applyPaymentSessionClaim,
  requirePaymentSessionClaim,
} from "#shared/db/payments/claims.ts";
import { paymentStoredJson } from "#shared/db/payments/codecs.ts";
import type { PaymentSession } from "#shared/db/payments/types.ts";
import {
  type PaymentReconcileOutcome,
  reconcilePayment,
} from "#shared/payment-runtime/process.ts";
import type { ProviderRead } from "#shared/payment-state/observation.ts";
import type { ProviderResource } from "#shared/payment-state/resources.ts";
import { stripePaymentProvider } from "#shared/stripe-provider.ts";
import {
  CHARGE_RESOURCE,
  PAYMENT_COMPLETED_BOOKING,
  PAYMENT_ID,
  PAYMENT_TIME,
  READY_RESULT,
  REFUND_RESOURCE,
  SESSION_RESOURCE,
  sessionProgress,
} from "#test/shared/db/payments/fixtures.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  completePayment,
  createPendingPayment,
  getStoredPayment,
  paymentProviderRead,
} from "./fixtures.ts";

const locator = { kind: "provider" as const, resource: SESSION_RESOURCE };
const RECONCILE_DELAY_MS = 60_000;

const unavailableRead = (requested: ProviderResource): ProviderRead => ({
  ownership: {
    localPaymentId: PAYMENT_ID,
    method: "staged",
    stageId: SESSION_RESOURCE.id,
  },
  reason: "timed_out",
  requested,
  status: "unavailable",
});

const pendingRefundRead = (): ProviderRead =>
  paymentProviderRead({
    charges: [
      {
        captured: { amount: 1_000, currency: "GBP" },
        confirmedRefunded: { amount: 0, currency: "GBP" },
        refunds: [
          {
            amount: { amount: 1_000, currency: "GBP" },
            refund: REFUND_RESOURCE,
            status: "pending",
          },
        ],
        resource: CHARGE_RESOURCE,
      },
    ],
  });

const reconcileRead = async (
  readValue: ProviderRead,
): Promise<{
  finishedAt: number;
  outcome: PaymentReconcileOutcome;
  payment: PaymentSession;
  startedAt: number;
}> => {
  await createPendingPayment();
  using _read = stub(stripePaymentProvider, "readPayment", () =>
    Promise.resolve(readValue),
  );
  const startedAt = Date.now();
  const outcome = await reconcilePayment("stripe", locator, completePayment);
  const finishedAt = Date.now();
  return {
    finishedAt,
    outcome,
    payment: await getStoredPayment(),
    startedAt,
  };
};

const expectScheduled = (
  payment: PaymentSession,
  startedAt: number,
  finishedAt: number,
): void => {
  expect(payment.nextReconcileAt).not.toBeNull();
  expect(payment.nextReconcileAt).toBeGreaterThanOrEqual(
    startedAt + RECONCILE_DELAY_MS,
  );
  expect(payment.nextReconcileAt).toBeLessThanOrEqual(
    finishedAt + RECONCILE_DELAY_MS,
  );
};

const recordRetry = (
  resource: ProviderResource,
  observedAt: number,
): ReturnType<typeof recordPaymentCase> =>
  recordPaymentCase(
    {
      evidence: { kind: "provider_read", read: unavailableRead(resource) },
      nextReconcileAt: observedAt + RECONCILE_DELAY_MS,
      paymentId: PAYMENT_ID,
      reason: "timed_out",
      resource,
      state: "retrying",
    },
    observedAt,
  );

describeWithEnv("payment reconciliation persistence", { db: true }, () => {
  test("schedules another check for a pending provider payment", async () => {
    const stored = await reconcileRead(
      paymentProviderRead({ charges: undefined, status: "pending" }),
    );

    expect(stored.outcome.status).toBe("pending");
    expectScheduled(stored.payment, stored.startedAt, stored.finishedAt);
  });

  test("schedules another check for a pending provider refund", async () => {
    const stored = await reconcileRead(pendingRefundRead());

    expect(stored.outcome.status).toBe("pending");
    expectScheduled(stored.payment, stored.startedAt, stored.finishedAt);
  });

  test("stores the exact typed provider read as case evidence", async () => {
    await createPendingPayment();
    const readValue = unavailableRead(SESSION_RESOURCE);
    using _read = stub(stripePaymentProvider, "readPayment", () =>
      Promise.resolve(readValue),
    );
    await reconcilePayment("stripe", locator, completePayment);
    const rows = resultRows<{ evidence: EnvKeyEncrypted }>(
      await getDb().execute(
        "SELECT evidence FROM payment_cases WHERE payment_id = ?",
        [PAYMENT_ID],
      ),
    );
    const [row] = rows;
    if (row === undefined) throw new Error("Expected stored payment case");

    expect(
      await paymentStoredJson.caseEvidence.open(row.evidence, "test evidence"),
    ).toEqual({ kind: "provider_read", read: readValue });
  });

  test("stops automatic reconciliation when the third retry needs action", async () => {
    await createPendingPayment();
    const now = Date.now();
    await recordRetry(SESSION_RESOURCE, now - 15 * 60_000);
    await recordRetry(SESSION_RESOURCE, now - 5 * 60_000);
    using read = stub(stripePaymentProvider, "readPayment", () =>
      Promise.resolve(unavailableRead(SESSION_RESOURCE)),
    );

    const outcome = await reconcilePayment("stripe", locator, completePayment);
    const payment = await getStoredPayment();
    const cases = await getDb().execute(
      `SELECT consecutive_count, next_reconcile_at, state
         FROM payment_cases WHERE payment_id = ?`,
      [PAYMENT_ID],
    );

    expect(outcome.status).toBe("conflict");
    expect(payment.state).toBe("needs_action");
    expect(payment.nextReconcileAt).toBeNull();
    expect(cases.rows).toEqual([
      {
        consecutive_count: 3,
        next_reconcile_at: null,
        state: "needs_action",
      },
    ]);
    expect(read.calls).toHaveLength(1);
  });

  test("closes only cases for resources in a successful observation", async () => {
    await createPendingPayment();
    const unrelated = { ...SESSION_RESOURCE, id: "unrelated-session" };
    const sessionCase = await recordRetry(SESSION_RESOURCE, PAYMENT_TIME);
    const chargeCase = await recordRetry(CHARGE_RESOURCE, PAYMENT_TIME);
    const refundCase = await recordRetry(REFUND_RESOURCE, PAYMENT_TIME);
    const unrelatedCase = await recordRetry(unrelated, PAYMENT_TIME);
    using _read = stub(stripePaymentProvider, "readPayment", () =>
      Promise.resolve(pendingRefundRead()),
    );

    const outcome = await reconcilePayment("stripe", locator, completePayment);
    const cases = await getDb().execute(
      "SELECT id, state FROM payment_cases ORDER BY id",
    );

    expect(outcome.status).toBe("pending");
    expect(cases.rows).toEqual([
      { id: sessionCase.paymentCase.id, state: "resolved" },
      { id: chargeCase.paymentCase.id, state: "resolved" },
      { id: refundCase.paymentCase.id, state: "resolved" },
      { id: unrelatedCase.paymentCase.id, state: "retrying" },
    ]);
  });

  test("replays a detached completed payment without provider IO", async () => {
    await createPendingPayment();
    const processing = await requirePaymentSessionClaim(PAYMENT_ID, 60_000);
    await applyPaymentSessionClaim(
      processing,
      sessionProgress({ nextReconcileAt: null, state: "processing" }),
    );
    const completing = await requirePaymentSessionClaim(PAYMENT_ID, 60_000);
    await applyPaymentSessionClaim(
      completing,
      sessionProgress({
        attendeeId: 42,
        completion: PAYMENT_COMPLETED_BOOKING,
        completionState: "completed",
        nextReconcileAt: null,
        result: READY_RESULT,
        resultState: "succeeded",
        state: "completed",
        ticketState: "consumed",
        ticketTokens: null,
      }),
    );
    await getDb().execute(
      "UPDATE payment_sessions SET attendee_id = NULL WHERE id = ?",
      [PAYMENT_ID],
    );
    using read = stub(stripePaymentProvider, "readPayment", () => {
      throw new Error("Terminal replay must not read the provider");
    });

    const outcome = await reconcilePayment("stripe", locator, completePayment);

    expect(outcome.status).toBe("ignore");
    expect(outcome.payment?.attendeeId).toBeNull();
    expect(read.calls).toHaveLength(0);
  });
});
