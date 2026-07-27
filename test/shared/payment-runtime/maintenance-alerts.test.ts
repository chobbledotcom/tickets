import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { spy } from "@std/testing/mock";
import {
  claimNextPaymentCaseAlert,
  markPaymentCaseAlertSent,
  releasePaymentCaseAlert,
} from "#shared/db/payments/case-alerts.ts";
import { recordPaymentCase } from "#shared/db/payments/cases.ts";
import type { PaymentCaseObservation } from "#shared/db/payments/types.ts";
import type { MaintenanceTaskContext } from "#shared/maintenance/definition.ts";
import { runPaymentCaseAlertMaintenance } from "#shared/payment-runtime/maintenance.ts";
import {
  PAYMENT_ID,
  PAYMENT_TIME,
  SESSION_RESOURCE,
} from "#test/shared/db/payments/fixtures.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { stubFetch } from "#test-utils/fetch-stub.ts";
import { maintenanceContext } from "#test-utils/maintenance.ts";

const alertCase: PaymentCaseObservation = {
  evidence: {
    kind: "provider_read",
    read: {
      reason: "unsupported_status",
      requested: SESSION_RESOURCE,
      status: "invalid",
    },
  },
  nextReconcileAt: null,
  paymentId: PAYMENT_ID,
  reason: "paid_without_charge",
  resource: SESSION_RESOURCE,
  state: "needs_action",
};

const retryCase = (nextReconcileAt: number): PaymentCaseObservation => ({
  ...alertCase,
  evidence: {
    kind: "provider_read",
    read: {
      ownership: {
        localPaymentId: PAYMENT_ID,
        method: "staged",
        stageId: SESSION_RESOURCE.id,
      },
      reason: "timed_out",
      requested: SESSION_RESOURCE,
      status: "unavailable",
    },
  },
  nextReconcileAt,
  reason: "timed_out",
  state: "retrying",
});

const alertCaseFor = (index: number): PaymentCaseObservation => {
  const resource = {
    ...SESSION_RESOURCE,
    id: `${SESSION_RESOURCE.id}-${index}`,
  };
  return {
    ...alertCase,
    evidence: {
      kind: "provider_read",
      read: {
        reason: "unsupported_status",
        requested: resource,
        status: "invalid",
      },
    },
    resource,
  };
};

const context = (
  overrides: Partial<MaintenanceTaskContext> = {},
): MaintenanceTaskContext =>
  maintenanceContext({ database: 8, external: 4, total: 12 }, overrides);

describeWithEnv(
  "payment case alert maintenance",
  { db: true, env: { NTFY_URL: "https://ntfy.test/payment-alerts" } },
  () => {
    test("queues one alert when repeated retries escalate", async () => {
      await recordPaymentCase(retryCase(PAYMENT_TIME + 60_000), PAYMENT_TIME);
      await recordPaymentCase(
        retryCase(PAYMENT_TIME + 6 * 60_000),
        PAYMENT_TIME + 5 * 60_000,
      );
      const escalatedAt = PAYMENT_TIME + 15 * 60_000;
      const first = await recordPaymentCase(
        retryCase(escalatedAt + 60_000),
        escalatedAt,
      );
      const repeated = await recordPaymentCase(
        retryCase(escalatedAt + 120_000),
        escalatedAt + 60_000,
      );

      expect(first.alerted).toBe(true);
      expect(repeated.alerted).toBe(false);
      const claim = await claimNextPaymentCaseAlert(60_000);
      expect(claim).toMatchObject({
        alertRevision: 3,
        caseId: first.paymentCase.id,
      });
      if (claim === null) throw new Error("Expected the queued payment alert");
      await markPaymentCaseAlertSent(claim, PAYMENT_TIME + 2);
      expect(await claimNextPaymentCaseAlert(60_000)).toBeNull();
    });

    test("releases a failed alert so the next run retries it", async () => {
      await recordPaymentCase(alertCase, PAYMENT_TIME);
      const failedFetch = stubFetch(new Error("ntfy unavailable"));
      const errorLog = spy(console, "error");

      await expect(runPaymentCaseAlertMaintenance(context())).rejects.toThrow(
        "Payment needs-action alert delivery failed",
      );
      expect(failedFetch.calls).toHaveLength(1);
      failedFetch.restore();
      using successfulFetch = stubFetch(new Response("ok"));

      await runPaymentCaseAlertMaintenance(context());

      expect(successfulFetch.calls).toHaveLength(1);
      expect(await claimNextPaymentCaseAlert(60_000)).toBeNull();
      errorLog.restore();
    });

    test("does not repeat a successfully delivered alert", async () => {
      await recordPaymentCase(alertCase, PAYMENT_TIME);
      using fetch = stubFetch(() => new Response("ok"));

      await runPaymentCaseAlertMaintenance(context());
      await runPaymentCaseAlertMaintenance(context());

      expect(fetch.calls).toHaveLength(1);
      const [url, init] = fetch.calls[0]!.args as [string, RequestInit];
      expect(url).toBe("https://ntfy.test/payment-alerts");
      expect(init.body).toBe("PAYMENT_NEEDS_ACTION");
    });

    test("gives one concurrent worker the alert delivery effect", async () => {
      await recordPaymentCase(alertCase, PAYMENT_TIME);
      const started = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      using fetch = stubFetch(async () => {
        started.resolve();
        await release.promise;
        return new Response("ok");
      });

      const first = runPaymentCaseAlertMaintenance(context());
      await started.promise;
      await runPaymentCaseAlertMaintenance(context());
      release.resolve();
      await first;

      expect(fetch.calls).toHaveLength(1);
    });

    test("requests a follow-up after one full alert page", async () => {
      await Promise.all(
        Array.from({ length: 4 }, (_, index) =>
          recordPaymentCase(alertCaseFor(index), PAYMENT_TIME + index),
        ),
      );
      using fetch = stubFetch(() => new Response("ok"));
      let followUps = 0;

      await runPaymentCaseAlertMaintenance(
        context({ requestFollowUp: () => followUps++ }),
      );

      expect(fetch.calls).toHaveLength(4);
      expect(followUps).toBe(1);
    });

    test("stops before claiming an alert without one item budget", async () => {
      await recordPaymentCase(alertCase, PAYMENT_TIME);
      using fetch = stubFetch(new Response("must not send"));
      let followUps = 0;

      await runPaymentCaseAlertMaintenance(
        context({
          budget: {
            remaining: () => ({ database: 1, external: 1, total: 2 }),
          },
          requestFollowUp: () => followUps++,
        }),
      );

      expect(fetch.calls).toHaveLength(0);
      expect(followUps).toBe(1);
    });

    test("rejects stale alert mark and release owners", async () => {
      await recordPaymentCase(alertCase, PAYMENT_TIME);
      const claim = await claimNextPaymentCaseAlert(60_000);
      if (claim === null) throw new Error("Expected the queued payment alert");
      await markPaymentCaseAlertSent(claim, PAYMENT_TIME + 1);

      await expect(markPaymentCaseAlertSent(claim)).rejects.toThrow(
        `Lost payment case alert lease for ${claim.caseId}`,
      );
      await expect(releasePaymentCaseAlert(claim)).rejects.toThrow(
        `Lost payment case alert lease for ${claim.caseId}`,
      );
      await expect(claimNextPaymentCaseAlert(0)).rejects.toThrow();
    });
  },
);
