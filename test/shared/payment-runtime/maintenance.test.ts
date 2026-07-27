import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import type { PaymentResult } from "#routes/api/webhook-types.ts";
import { getDb } from "#shared/db/client.ts";
import { getPaymentCaseDecisions } from "#shared/db/payments/decisions.ts";
import type { DuePaymentSession } from "#shared/db/payments/due.ts";
import { createPaymentSession } from "#shared/db/payments/sessions.ts";
import { settings } from "#shared/db/settings.ts";
import type { MaintenanceTaskContext } from "#shared/maintenance/definition.ts";
import { resolvePaymentAccount } from "#shared/payment-runtime/account.ts";
import {
  type PaymentDecisionMaintenanceActions,
  type PaymentMaintenanceActions,
  processDuePaymentDecision,
  processDuePaymentSession,
  runPaymentDecisionMaintenance,
  runPaymentReconciliationMaintenance,
} from "#shared/payment-runtime/maintenance.ts";
import { resumePaymentDecision } from "#shared/payment-runtime/operator.ts";
import {
  completedProviderRefund,
  pendingProviderRefund,
} from "#shared/payment-runtime/provider-refund.ts";
import { refundCharges } from "#shared/payment-runtime/refund.ts";
import { squarePaymentProvider } from "#shared/square-provider.ts";
import { stripePaymentProvider } from "#shared/stripe-provider.ts";
import {
  PAYMENT_CHECKOUT_CREATE,
  PAYMENT_ID,
  PAYMENT_TIME,
  paymentSessionInput,
  REFUND_RESOURCE,
} from "#test/shared/db/payments/fixtures.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { maintenanceContext } from "#test-utils/maintenance.ts";
import {
  createAcceptedRefundDecision,
  createRefundablePayment,
  getStoredPayment,
} from "./fixtures.ts";

const dueStates = [
  "pending",
  "ready",
  "processing",
  "refunding",
  "completed",
  "fully_refunded",
] as const satisfies readonly DuePaymentSession["state"][];

const successfulResult: PaymentResult = {
  attendee: { id: 1 },
  listingId: 1,
  success: true,
  ticketTokens: [],
};

const fakeActions = () => {
  const calls: string[] = [];
  const fulfil = (): Promise<PaymentResult> =>
    Promise.resolve(successfulResult);
  const actions: PaymentMaintenanceActions = {
    fulfil,
    reconcile: (provider, locator, receivedFulfil, mode) => {
      expect(receivedFulfil).toBe(fulfil);
      expect(mode).toBe("maintenance");
      calls.push(`reconcile:${provider}:${locator.id}`);
      return Promise.resolve(undefined);
    },
    resumeCheckout: (id) => {
      calls.push(`resume:${id}`);
      return Promise.resolve();
    },
  };
  return { actions, calls };
};

const duePayment = (
  state: DuePaymentSession["state"],
  provider = "stripe" as const,
): DuePaymentSession => ({
  bulkRefund: false,
  id: `payment-${state}`,
  nextReconcileAt: 0,
  provider,
  state,
});

const context = (
  overrides: Partial<MaintenanceTaskContext> = {},
): MaintenanceTaskContext =>
  maintenanceContext({ database: 21, external: 11, total: 32 }, overrides);

const recordingDecisionActions = (
  calls: number[],
): PaymentDecisionMaintenanceActions => ({
  fulfil: () => Promise.resolve(successfulResult),
  resume: (id) => {
    calls.push(id);
    return Promise.resolve();
  },
});

describeWithEnv("payment reconciliation maintenance", { db: true }, () => {
  test("dispatches a due saved owner decision", async () => {
    const calls: number[] = [];

    await processDuePaymentDecision(
      { caseId: 7, id: 9 },
      recordingDecisionActions(calls),
    );

    expect(calls).toEqual([9]);
  });

  test("maintenance finds an accepted owner decision after a crash", async () => {
    const { decision } = await createAcceptedRefundDecision();
    const calls: number[] = [];
    let followUps = 0;

    await runPaymentDecisionMaintenance(
      context({ requestFollowUp: () => followUps++ }),
      recordingDecisionActions(calls),
    );

    expect(calls).toEqual([decision.id]);
    expect(followUps).toBe(1);
  });

  test("maintenance completes a due accepted refund decision", async () => {
    const target = await createAcceptedRefundDecision();
    const { decision } = target;
    using provider = stub(stripePaymentProvider, "refundCharge", (charge) =>
      Promise.resolve({
        amount: charge.captured,
        refund: {
          ...REFUND_RESOURCE,
          id: `maintenance-refund-${charge.id}`,
          parentId: charge.providerReference.id,
        },
        status: "completed" as const,
      }),
    );

    await runPaymentDecisionMaintenance(context(), {
      fulfil: () => Promise.resolve(successfulResult),
      resume: resumePaymentDecision,
    });

    expect(provider.calls).toHaveLength(2);
    expect(await getPaymentCaseDecisions(target.paymentCase.id)).toMatchObject([
      { id: decision.id, state: "completed" },
    ]);
  });

  test("refuses a queued bulk refund whose payment came back empty", async () => {
    // The refund was queued against a payment, so reconciling it has to hand
    // that payment back. Coming back with nothing means the books cannot be
    // squared, and saying so beats carrying on with a missing record.
    const { actions } = fakeActions();
    const losingActions: PaymentMaintenanceActions = {
      ...actions,
      reconcile: () =>
        Promise.resolve({ payment: null, status: "retry" as const }),
    };

    await expect(
      processDuePaymentSession(
        { ...duePayment("refunding"), bulkRefund: true },
        losingActions,
      ),
    ).rejects.toThrow("lost its payment aggregate");
  });

  test("resumes created checkout input through the create runtime", async () => {
    const { actions, calls } = fakeActions();

    await processDuePaymentSession(duePayment("created"), actions);

    expect(calls).toEqual(["resume:payment-created"]);
  });

  test("dispatches every stored due state through local reconciliation", async () => {
    const { actions, calls } = fakeActions();

    for (const state of dueStates) {
      await processDuePaymentSession(duePayment(state), actions);
    }

    expect(calls).toEqual(
      dueStates.map((state) => `reconcile:stripe:payment-${state}`),
    );
  });

  test("uses the payment's stored provider after the active provider changes", async () => {
    const { actions, calls } = fakeActions();
    settings.setForTest({ payment_provider: "square" });

    await processDuePaymentSession(duePayment("pending", "stripe"), actions);

    expect(calls).toEqual(["reconcile:stripe:payment-pending"]);
  });

  test("requests a follow-up after processing a full page", async () => {
    await createPaymentSession(paymentSessionInput(), PAYMENT_TIME);
    await getDb().execute(
      `UPDATE payment_sessions
          SET state = 'pending', next_reconcile_at = 0
        WHERE id = ?`,
      [PAYMENT_ID],
    );
    const { actions, calls } = fakeActions();
    let followUps = 0;

    await runPaymentReconciliationMaintenance(
      context({ requestFollowUp: () => followUps++ }),
      actions,
    );

    expect(calls).toEqual([`reconcile:stripe:${PAYMENT_ID}`]);
    expect(followUps).toBe(1);
  });

  test("stops before an item when its budget or deadline is exhausted", async () => {
    await createPaymentSession(paymentSessionInput(), PAYMENT_TIME);
    await getDb().execute(
      "UPDATE payment_sessions SET state = 'pending', next_reconcile_at = 0",
    );
    const { actions, calls } = fakeActions();
    let followUps = 0;
    const requestFollowUp = () => followUps++;

    await runPaymentReconciliationMaintenance(
      context({
        budget: {
          remaining: () => ({ database: 20, external: 11, total: 31 }),
        },
        requestFollowUp,
      }),
      actions,
    );
    await runPaymentReconciliationMaintenance(
      context({ deadline: Date.now(), requestFollowUp }),
      actions,
    );

    expect(calls).toEqual([]);
    expect(followUps).toBe(2);
  });

  test("polls a pending refund through the stored refund engine", async () => {
    const target = await createRefundablePayment();
    let providerCalls = 0;
    using _refund = stub(stripePaymentProvider, "refundCharge", (charge) => {
      providerCalls += 1;
      return Promise.resolve(
        providerCalls === 1
          ? pendingProviderRefund(charge, null)
          : completedProviderRefund(charge, null),
      );
    });
    await refundCharges(target.payment, target.charges);
    await getDb().execute(
      "UPDATE payment_sessions SET next_reconcile_at = 0 WHERE id = ?",
      [PAYMENT_ID],
    );

    await runPaymentReconciliationMaintenance(context());

    expect(providerCalls).toBe(2);
    expect((await getStoredPayment()).state).toBe("fully_refunded");
  });

  test("allows only one concurrent maintenance effect for one due checkout", async () => {
    settings.setForTest({
      currency: "GBP",
      payment_provider: "square",
      square_access_token: "square-token",
      square_location_id: "location-one",
    });
    const account = await resolvePaymentAccount("square");
    await createPaymentSession(
      {
        ...paymentSessionInput(PAYMENT_ID, null),
        accountId: account.accountId,
        checkoutCreate: PAYMENT_CHECKOUT_CREATE,
        mode: account.mode,
        provider: "square",
      },
      PAYMENT_TIME,
    );
    await getDb().execute(
      "UPDATE payment_sessions SET next_reconcile_at = 0 WHERE id = ?",
      [PAYMENT_ID],
    );
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    using create = stub(squarePaymentProvider, "createCheckout", async () => {
      started.resolve();
      await release.promise;
      return null;
    });

    const first = runPaymentReconciliationMaintenance(context());
    await started.promise;
    const second = runPaymentReconciliationMaintenance(context());
    await second;
    release.resolve();
    await first;

    expect(create.calls).toHaveLength(1);
  });
});
