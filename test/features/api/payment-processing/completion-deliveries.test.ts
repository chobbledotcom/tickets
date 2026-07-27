import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { deliverNextPaidCompletion } from "#routes/api/payment-processing/completion-deliveries.ts";
import {
  applyPaymentSessionClaimKeepingLease,
  requirePaymentSessionClaim,
} from "#shared/db/payments/claims.ts";
import {
  getPendingPaymentCompletionDeliveries,
  storePaymentCompletionDeliveries,
} from "#shared/db/payments/completion-deliveries.ts";
import { runPaymentCompletionDbEffect } from "#shared/db/payments/completion-effects.ts";
import { paymentProgress } from "#shared/payment-runtime/progress.ts";
import { prepareRegistrationWebhookDeliveries } from "#shared/webhook-paid.ts";
import { PAYMENT_ID } from "#test/shared/db/payments/fixtures.ts";
import { createPendingPayment } from "#test/shared/payment-runtime/fixtures.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { makeTestEntry } from "#test-utils/factories.ts";
import { stubFetch } from "#test-utils/fetch-stub.ts";

const completionCurrent = async () => {
  const payment = await createPendingPayment();
  const claim = await requirePaymentSessionClaim(PAYMENT_ID, 60_000);
  return applyPaymentSessionClaimKeepingLease(
    claim,
    paymentProgress(payment, {
      nextReconcileAt: Date.now(),
      state: payment.state,
    }),
  );
};

const storeWebhookRows = async (
  current: Awaited<ReturnType<typeof completionCurrent>>,
  urls: string[],
): Promise<void> => {
  const deliveries = await prepareRegistrationWebhookDeliveries(
    urls.map((webhookUrl, index) =>
      makeTestEntry({ id: index + 1, webhook_url: webhookUrl }),
    ),
    "GBP",
  );
  await runPaymentCompletionDbEffect(
    current.claim,
    "external_delivery_setup",
    async (transaction) => {
      await storePaymentCompletionDeliveries(
        transaction,
        current.payment.id,
        deliveries,
      );
      return null;
    },
  );
};

describeWithEnv("paid completion delivery outbox", { db: true }, () => {
  test("delivers a bounded page without truncating webhook destinations", async () => {
    const current = await completionCurrent();
    await storeWebhookRows(current, [
      "https://one.example.com/hook",
      "https://two.example.com/hook",
      "https://three.example.com/hook",
    ]);
    const fetch = stubFetch(() => new Response());
    try {
      expect(await deliverNextPaidCompletion(current)).toBe(false);
      expect(fetch.calls).toHaveLength(1);
      expect(await deliverNextPaidCompletion(current)).toBe(false);
      expect(fetch.calls).toHaveLength(2);
      expect(await deliverNextPaidCompletion(current)).toBe(true);
      expect(fetch.calls).toHaveLength(3);
      expect(
        await getPendingPaymentCompletionDeliveries(current.payment.id),
      ).toEqual([]);
    } finally {
      fetch.restore();
    }
  });

  test("keeps a failed webhook row pending while the payment remains due", async () => {
    const current = await completionCurrent();
    await storeWebhookRows(current, ["https://failed.example.com/hook"]);
    const fetch = stubFetch(() => new Response("failed", { status: 500 }));
    try {
      await expect(deliverNextPaidCompletion(current)).rejects.toThrow(
        "Webhook delivery failed with status 500",
      );

      expect(
        await getPendingPaymentCompletionDeliveries(current.payment.id),
      ).toHaveLength(1);
      expect(current.payment.nextReconcileAt).not.toBeNull();
    } finally {
      fetch.restore();
    }
  });
});
