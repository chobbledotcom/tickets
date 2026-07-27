import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getDb } from "#shared/db/client.ts";
import {
  recordPaymentCase,
  resolvePaymentCaseForResource,
} from "#shared/db/payments/cases.ts";
import type { PaymentCaseObservation } from "#shared/db/payments/types.ts";
import type { ProviderUnavailableReason } from "#shared/payment-state/observation.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { PAYMENT_ID, PAYMENT_TIME, SESSION_RESOURCE } from "./fixtures.ts";

const retry = (
  reason: ProviderUnavailableReason,
  nextReconcileAt: number,
): PaymentCaseObservation => ({
  evidence: {
    kind: "provider_read",
    read: {
      reason,
      requested: SESSION_RESOURCE,
      status: "unavailable",
    },
  },
  nextReconcileAt,
  paymentId: PAYMENT_ID,
  reason,
  resource: SESSION_RESOURCE,
  state: "retrying" as const,
});

describeWithEnv("db > payments > cases", { db: true }, () => {
  test("atomically promotes the third same-reason retry after fifteen minutes", async () => {
    const first = await recordPaymentCase(
      retry("network_error", PAYMENT_TIME + 60_000),
      PAYMENT_TIME,
    );
    const second = await recordPaymentCase(
      retry("network_error", PAYMENT_TIME + 6 * 60_000),
      PAYMENT_TIME + 5 * 60_000,
    );
    const alertAt = PAYMENT_TIME + 15 * 60 * 1000;
    const third = await recordPaymentCase(
      retry("network_error", alertAt + 60_000),
      alertAt,
    );

    expect(first.alerted).toBe(false);
    expect(second.alerted).toBe(false);
    expect(third.alerted).toBe(true);
    expect(third.paymentCase.state).toBe("needs_action");
    expect(third.paymentCase.consecutiveCount).toBe(3);
    expect(third.paymentCase.nextReconcileAt).toBeNull();
    expect(third.paymentCase.alertedAt).toBe(alertAt);
  });

  test("does not alert after only two observations", async () => {
    await recordPaymentCase(
      retry("network_error", PAYMENT_TIME + 60_000),
      PAYMENT_TIME,
    );
    const second = await recordPaymentCase(
      retry("network_error", PAYMENT_TIME + 15 * 60 * 1000 + 60_000),
      PAYMENT_TIME + 15 * 60 * 1000,
    );

    expect(second.alerted).toBe(false);
    expect(second.paymentCase.state).toBe("retrying");
    expect(second.paymentCase.consecutiveCount).toBe(2);
  });

  test("does not alert three observations before fifteen minutes", async () => {
    await recordPaymentCase(
      retry("network_error", PAYMENT_TIME + 60_000),
      PAYMENT_TIME,
    );
    await recordPaymentCase(
      retry("network_error", PAYMENT_TIME + 120_000),
      PAYMENT_TIME + 60_000,
    );
    const third = await recordPaymentCase(
      retry("network_error", PAYMENT_TIME + 15 * 60 * 1000),
      PAYMENT_TIME + 15 * 60 * 1000 - 1,
    );

    expect(third.alerted).toBe(false);
    expect(third.paymentCase.state).toBe("retrying");
    expect(third.paymentCase.consecutiveCount).toBe(3);
  });

  test("requires reconcile time only for retrying cases", async () => {
    await expect(
      recordPaymentCase(
        {
          ...retry("network_error", PAYMENT_TIME),
          nextReconcileAt: null,
        },
        PAYMENT_TIME,
      ),
    ).rejects.toThrow("Only retrying payment cases have a next reconcile time");
    await expect(
      recordPaymentCase(
        {
          ...retry("network_error", PAYMENT_TIME),
          state: "needs_action",
        },
        PAYMENT_TIME,
      ),
    ).rejects.toThrow("Only retrying payment cases have a next reconcile time");
  });

  test("accepts zero for every case timestamp boundary", async () => {
    const first = await recordPaymentCase(retry("network_error", 0), 0);
    expect(first.paymentCase.firstObservedAt).toBe(0);
    expect(first.paymentCase.lastObservedAt).toBe(0);
    expect(first.paymentCase.nextReconcileAt).toBe(0);

    expect(
      await resolvePaymentCaseForResource(PAYMENT_ID, SESSION_RESOURCE, 0),
    ).toBe(true);
  });

  test("reports one alerted transition only", async () => {
    const issue = {
      evidence: {
        kind: "provider_read" as const,
        read: {
          reason: "unsupported_status" as const,
          requested: SESSION_RESOURCE,
          status: "invalid" as const,
        },
      },
      nextReconcileAt: null,
      paymentId: PAYMENT_ID,
      reason: "paid_without_charge",
      resource: SESSION_RESOURCE,
      state: "needs_action" as const,
    };

    const first = await recordPaymentCase(issue, PAYMENT_TIME);
    const repeated = await recordPaymentCase(issue, PAYMENT_TIME);

    expect(first.alerted).toBe(true);
    expect(repeated.alerted).toBe(false);
    expect(repeated.paymentCase.consecutiveCount).toBe(2);
    expect(repeated.paymentCase.alertedAt).toBe(PAYMENT_TIME);
  });

  test("resets consecutive observations when the reason changes", async () => {
    await recordPaymentCase(
      retry("network_error", PAYMENT_TIME + 60_000),
      PAYMENT_TIME,
    );
    await recordPaymentCase(
      retry("network_error", PAYMENT_TIME + 120_000),
      PAYMENT_TIME + 60_000,
    );

    const changed = await recordPaymentCase(
      retry("timed_out", PAYMENT_TIME + 180_000),
      PAYMENT_TIME + 120_000,
    );

    expect(changed.paymentCase.reason).toBe("timed_out");
    expect(changed.paymentCase.consecutiveCount).toBe(1);
    expect(changed.paymentCase.firstObservedAt).toBe(PAYMENT_TIME + 120_000);
    expect(changed.paymentCase.alertedAt).toBeNull();
  });

  test("resolves a payment case by its resource once", async () => {
    await recordPaymentCase(
      retry("timed_out", PAYMENT_TIME + 120_000),
      PAYMENT_TIME + 2,
    );
    expect(
      await resolvePaymentCaseForResource(
        PAYMENT_ID,
        SESSION_RESOURCE,
        PAYMENT_TIME + 3,
      ),
    ).toBe(true);
    expect(
      await resolvePaymentCaseForResource(
        PAYMENT_ID,
        SESSION_RESOURCE,
        PAYMENT_TIME + 4,
      ),
    ).toBe(false);
  });

  test("encrypts case resources and evidence", async () => {
    const created = await recordPaymentCase(
      retry("network_error", PAYMENT_TIME + 60_000),
      PAYMENT_TIME,
    );
    const result = await getDb().execute(
      "SELECT resource, evidence FROM payment_cases WHERE id = ?",
      [created.paymentCase.id],
    );
    expect(String(result.rows[0]?.resource)).toMatch(/^enc:1:/);
    expect(String(result.rows[0]?.evidence)).toMatch(/^enc:1:/);
    expect(JSON.stringify(result.rows[0])).not.toContain("network_error");
  });

  test("round trips exact typed provider evidence", async () => {
    const observation = retry("rate_limited", PAYMENT_TIME + 60_000);
    const created = await recordPaymentCase(observation, PAYMENT_TIME);

    expect(created.paymentCase.evidence).toEqual(observation.evidence);
  });
});
