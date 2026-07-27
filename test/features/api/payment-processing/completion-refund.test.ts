/* jscpd:ignore-start -- imports */
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import {
  completePlaceholderRefund,
  type PlaceholderCompletionActions,
  type PlaceholderCompletionContext,
  placeholderCompletionActions,
} from "#routes/api/payment-processing/completion-refund.ts";
import { completedStep } from "#routes/api/payment-processing/completion-runtime.ts";
import type {
  PaymentFailureResult,
  PaymentWork,
} from "#routes/api/webhook-types.ts";
import { decrypt } from "#shared/crypto/encryption.ts";
import type { EnvKeyEncrypted } from "#shared/crypto/sealed.ts";
import { getDb } from "#shared/db/client.ts";
import { savePaymentCharges } from "#shared/db/payments/charges.ts";
import {
  applyPaymentSessionClaimKeepingLease,
  requirePaymentSessionClaim,
} from "#shared/db/payments/claims.ts";
import {
  type PlaceholderRefundCompletion,
  placeholderRefundCompletion,
} from "#shared/payment-completion.ts";
import { runPaymentReconciliationMaintenance } from "#shared/payment-runtime/maintenance.ts";
import { reconcilePayment } from "#shared/payment-runtime/process.ts";
import { paymentProgress } from "#shared/payment-runtime/progress.ts";
import { stripePaymentProvider } from "#shared/stripe-provider.ts";
import {
  CHARGE_RESOURCE,
  PAYMENT_BOOKING_COMPLETION,
  PAYMENT_ID,
  PAYMENT_INTENT,
  PAYMENT_TIME,
  paymentSessionInput,
  READY_RESULT,
  REFUND_RESOURCE,
  SESSION_RESOURCE,
} from "#test/shared/db/payments/fixtures.ts";
import {
  createPendingPayment,
  getStoredPayment,
} from "#test/shared/payment-runtime/fixtures.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createPaidAttendeeWithoutLedger } from "#test-utils/db-helpers/attendee-payments.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { maintenanceContext } from "#test-utils/maintenance.ts";
import {
  paymentWorkForCompletion,
  reclaimPaymentWork,
} from "#test-utils/payment-completion.ts";

/* jscpd:ignore-end */

const refundWork = async (): Promise<PaymentWork> => {
  const listing = await createTestListing({ unitPrice: 1_000 });
  const attendee = await createPaidAttendeeWithoutLedger(
    listing.id,
    "Refund placeholder",
    "refund-placeholder@example.com",
    "",
    0,
    0,
  );
  const intent = {
    ...PAYMENT_INTENT,
    items: [{ e: listing.id, p: 1_000, q: 1 }],
  };
  const payment = await createPendingPayment({
    ...paymentSessionInput(),
    bookingIntent: intent,
  });
  const resolution = {
    ...READY_RESULT,
    observation: {
      ...READY_RESULT.observation,
      bookingIntent: intent,
      charges: [
        {
          captured: { amount: 1_000, currency: "GBP" },
          confirmedRefunded: { amount: 0, currency: "GBP" },
          refunds: [],
          resource: CHARGE_RESOURCE,
        },
      ],
    },
  };
  await savePaymentCharges(
    PAYMENT_ID,
    SESSION_RESOURCE,
    resolution.observation.charges,
    PAYMENT_TIME,
  );
  const claim = await requirePaymentSessionClaim(PAYMENT_ID, 60_000);
  const processing = await applyPaymentSessionClaimKeepingLease(
    claim,
    paymentProgress(payment, {
      nextReconcileAt: Date.now() + 60_000,
      result: resolution,
      resultState: "succeeded",
      state: "processing",
    }),
  );
  const completion = placeholderRefundCompletion(
    intent,
    {
      amount: 1_000,
      listingId: listing.id,
      occurredAt: READY_RESULT.observation.createdAt,
      spec: {
        code: "price_changed",
        detail: "The price changed during payment",
        reason: "the listing price changed while they were paying",
      },
    },
    {
      detail: "The price changed during payment",
      error: "We saved your booking details. We are arranging your refund.",
      refund: {
        amount: { amount: 0, currency: "GBP" },
        status: "pending",
      },
      status: 200,
      success: false,
    },
  );
  const attached = await applyPaymentSessionClaimKeepingLease(
    processing.claim,
    paymentProgress(processing.payment, {
      attendeeId: attendee.id,
      completion,
      completionState: "pending",
      nextReconcileAt: Date.now() + 60_000,
      state: "processing",
      ticketState: "consumed",
      ticketTokens: null,
    }),
  );
  return paymentWorkForCompletion(attached, resolution);
};

const completedRefund = (parentId: string) =>
  Promise.resolve({
    amount: { amount: 1_000, currency: "GBP" },
    refund: { ...REFUND_RESOURCE, parentId },
    status: "completed" as const,
  });

const paymentMaintenanceContext = () =>
  maintenanceContext({ database: 21, external: 11, total: 32 });

const completionRows = async (attendeeId: number) => {
  const [transfers, notes, activity] = await Promise.all([
    getDb().execute(
      `SELECT kind FROM transfers
        WHERE (source_type = 'attendee' AND source_id = ?)
           OR (dest_type = 'attendee' AND dest_id = ?)
        ORDER BY kind`,
      [String(attendeeId), String(attendeeId)],
    ),
    getDb().execute(
      "SELECT note FROM system_notes WHERE attendee_id = ? ORDER BY id",
      [attendeeId],
    ),
    getDb().execute(
      "SELECT COUNT(*) AS count FROM activity_log WHERE attendee_id = ?",
      [attendeeId],
    ),
  ]);
  return { activity, notes, transfers };
};

describeWithEnv("durable placeholder refund completion", { db: true }, () => {
  test("rejects a payment with the wrong completion kind", async () => {
    const work = await refundWork();
    work.payment.completion = PAYMENT_BOOKING_COMPLETION;

    await expect(completePlaceholderRefund(work)).rejects.toThrow(
      `Payment ${PAYMENT_ID} has no placeholder completion`,
    );
  });

  test("releases the claim after a provider refund error", async () => {
    const work = await refundWork();
    using _provider = stub(stripePaymentProvider, "refundCharge", () =>
      Promise.reject(new Error("Refund transport failed")),
    );

    await expect(completePlaceholderRefund(work)).rejects.toThrow(
      "Refund transport failed",
    );

    const replacement = await requirePaymentSessionClaim(PAYMENT_ID, 60_000);
    expect(replacement.paymentId).toBe(PAYMENT_ID);
  });

  test("callback refunds once and replays while local effects remain due", async () => {
    const work = await refundWork();
    using refund = stub(stripePaymentProvider, "refundCharge", (charge) =>
      completedRefund(charge.providerReference.id),
    );
    const effects: string[] = [];
    const deferred =
      (effect: string) => async (context: PlaceholderCompletionContext) => {
        effects.push(effect);
        return completedStep<PaymentFailureResult, PlaceholderRefundCompletion>(
          context.current,
        );
      };
    const actions: PlaceholderCompletionActions = {
      completed_note: deferred("completed_note"),
      operator_alert: deferred("operator_alert"),
      payment_ledger: deferred("payment_ledger"),
      pending_note: deferred("pending_note"),
      provider_refund: placeholderCompletionActions.provider_refund,
      refund_activity: deferred("refund_activity"),
      refund_ledger: deferred("refund_ledger"),
    };

    const result = await completePlaceholderRefund(work, actions, "critical");
    const stored = await getStoredPayment();
    expect(result.refund?.status).toBe("completed");
    expect(stored.state).toBe("fully_refunded");
    expect(stored.completionState).toBe("pending");
    expect(effects).toEqual([]);
    using read = stub(stripePaymentProvider, "readPayment", () => {
      throw new Error("Stored refund replay must not read the provider");
    });
    let fulfilCalls = 0;

    const replay = await reconcilePayment(
      "stripe",
      { id: PAYMENT_ID, kind: "local" },
      () => {
        fulfilCalls += 1;
        throw new Error("Stored refund replay must not run completion");
      },
    );

    expect(replay).toMatchObject({ result, status: "fulfilled" });
    expect(refund.calls).toHaveLength(1);
    expect(read.calls).toHaveLength(0);
    expect(fulfilCalls).toBe(0);
    expect((await getStoredPayment()).completionState).toBe("pending");
  });

  test("maintenance repairs a pending refund and finishes local effects", async () => {
    const work = await refundWork();
    let providerCalls = 0;
    using _provider = stub(stripePaymentProvider, "refundCharge", (charge) => {
      providerCalls += 1;
      return providerCalls === 1
        ? Promise.resolve({
            amount: charge.captured,
            refund: {
              ...REFUND_RESOURCE,
              parentId: charge.providerReference.id,
            },
            status: "pending" as const,
          })
        : completedRefund(charge.providerReference.id);
    });
    using read = stub(stripePaymentProvider, "readPayment", () => {
      throw new Error("Stored completion must not re-read the payment");
    });

    const pending = await completePlaceholderRefund(work);
    expect(pending.refund?.status).toBe("pending");
    const pendingPayment = await getStoredPayment();
    expect(pendingPayment.state).toBe("refunding");
    if (pendingPayment.completion?.kind !== "placeholder_refund") {
      throw new Error("Expected placeholder completion");
    }
    expect(pendingPayment.completion.effects.provider_refund).toBe("pending");
    const pendingRows = await completionRows(pendingPayment.attendeeId!);
    expect(pendingRows.transfers.rows).toEqual([]);
    expect(pendingRows.notes.rows).toHaveLength(0);
    await getDb().execute(
      "UPDATE payment_sessions SET next_reconcile_at = 0 WHERE id = ?",
      [PAYMENT_ID],
    );

    await runPaymentReconciliationMaintenance(paymentMaintenanceContext());

    const completed = await getStoredPayment();
    const completedRows = await completionRows(completed.attendeeId!);
    expect(completed.state).toBe("fully_refunded");
    expect(completed.completionState).toBe("completed");
    expect(completedRows.transfers.rows).toEqual([
      { kind: "payment" },
      { kind: "refund_cash" },
    ]);
    expect(completedRows.notes.rows).toHaveLength(1);
    const encrypted = completedRows.notes.rows[0]?.note;
    if (typeof encrypted !== "string") throw new Error("Expected refund note");
    expect(await decrypt(encrypted as EnvKeyEncrypted)).toContain(
      "its payment was refunded",
    );
    expect(Number(completedRows.activity.rows[0]?.count)).toBe(1);
    expect(providerCalls).toBe(2);
    expect(read.calls).toHaveLength(0);
  });

  for (const failedEffect of ["refund_ledger", "completed_note"] as const) {
    test(`retries ${failedEffect} after provider success without another refund request`, async () => {
      const work = await refundWork();
      let providerCalls = 0;
      using _provider = stub(
        stripePaymentProvider,
        "refundCharge",
        (charge) => {
          providerCalls += 1;
          return completedRefund(charge.providerReference.id);
        },
      );
      let fail = true;
      const original = placeholderCompletionActions[failedEffect];
      const actions: PlaceholderCompletionActions = {
        ...placeholderCompletionActions,
      };
      actions[failedEffect] = async (context: PlaceholderCompletionContext) => {
        if (fail) {
          fail = false;
          throw new Error(`${failedEffect} write failed`);
        }
        return original(context);
      };

      await expect(completePlaceholderRefund(work, actions)).rejects.toThrow(
        `${failedEffect} write failed`,
      );
      const afterFailure = await getStoredPayment();
      expect(afterFailure.state).toBe("fully_refunded");
      if (afterFailure.completion?.kind !== "placeholder_refund") {
        throw new Error("Expected placeholder completion");
      }
      expect(afterFailure.completion.effects[failedEffect]).toBe("pending");

      let result: PaymentFailureResult | null = null;
      if (failedEffect === "refund_ledger") {
        await getDb().execute(
          "UPDATE payment_sessions SET next_reconcile_at = 0 WHERE id = ?",
          [PAYMENT_ID],
        );
        await runPaymentReconciliationMaintenance(paymentMaintenanceContext());
      } else {
        result = await completePlaceholderRefund(
          await reclaimPaymentWork(work),
          actions,
        );
      }
      const completed = await getStoredPayment();
      const rows = await completionRows(completed.attendeeId!);

      if (result !== null) expect(result.refund?.status).toBe("completed");
      expect(completed.completionState).toBe("completed");
      expect(providerCalls).toBe(1);
      expect(rows.transfers.rows).toEqual([
        { kind: "payment" },
        { kind: "refund_cash" },
      ]);
      expect(rows.notes.rows).toHaveLength(1);
      expect(Number(rows.activity.rows[0]?.count)).toBe(1);
    });
  }
});
