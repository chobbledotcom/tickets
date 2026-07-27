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
import { settings } from "#shared/db/settings.ts";
import { prepareRegistrationEmailDeliveries } from "#shared/email.ts";
import type { PreparedPaymentCompletionDelivery } from "#shared/payment-completion-delivery.ts";
import { paymentProgress } from "#shared/payment-runtime/progress.ts";
import { prepareRegistrationWebhookDeliveries } from "#shared/webhook-paid.ts";
import { PAYMENT_ID } from "#test/shared/db/payments/fixtures.ts";
import { createPendingPayment } from "#test/shared/payment-runtime/fixtures.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { saveTestEmailConfig, validEmail } from "#test-utils/email.ts";
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

/** Save whatever deliveries the given prepare step produced, so the outbox has
 *  real rows to hand out. */
const storeRows = async (
  current: Awaited<ReturnType<typeof completionCurrent>>,
  deliveries: PreparedPaymentCompletionDelivery[],
): Promise<void> => {
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
  await storeRows(current, deliveries);
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

  test("sends the buyer's confirmation email from the outbox", async () => {
    const current = await completionCurrent();
    await saveTestEmailConfig();
    await storeRows(
      current,
      await prepareRegistrationEmailDeliveries(
        [makeTestEntry({ id: 1 })],
        "GBP",
      ),
    );
    const fetch = stubFetch(() => new Response());
    try {
      expect(await deliverNextPaidCompletion(current)).toBe(true);

      expect(fetch.calls).toHaveLength(1);
      expect(
        await getPendingPaymentCompletionDeliveries(current.payment.id),
      ).toEqual([]);
    } finally {
      fetch.restore();
      settings.clearTestOverrides();
    }
  });

  test("refuses to send once the email settings have changed", async () => {
    const current = await completionCurrent();
    await saveTestEmailConfig();
    await storeRows(
      current,
      await prepareRegistrationEmailDeliveries(
        [makeTestEntry({ id: 1 })],
        "GBP",
      ),
    );
    await saveTestEmailConfig({ fromAddress: "someone-else@test.com" });
    const fetch = stubFetch(() => new Response());
    try {
      await expect(deliverNextPaidCompletion(current)).rejects.toThrow(
        "Email settings changed after payment completion started",
      );

      expect(fetch.calls).toHaveLength(0);
    } finally {
      fetch.restore();
      settings.clearTestOverrides();
    }
  });

  test("prepares nothing to email when no email provider is set up", async () => {
    expect(
      await prepareRegistrationEmailDeliveries(
        [makeTestEntry({ id: 1 })],
        "GBP",
      ),
    ).toEqual([]);
  });

  test("refuses to email about site assignments that are not there", async () => {
    const current = await completionCurrent();
    await saveTestEmailConfig();
    await storeRows(current, [
      {
        data: {
          assignmentKeys: ["site-assignment:0"],
          config: {
            fromAddress: validEmail("from@test.com"),
            provider: "resend",
          },
          kind: "site_assignment_email",
          recipient: validEmail("buyer@example.com"),
        },
        key: "site-assignment-email:0",
      },
    ]);

    try {
      await expect(deliverNextPaidCompletion(current)).rejects.toThrow(
        "has missing site assignments",
      );
    } finally {
      settings.clearTestOverrides();
    }
  });

  test("refuses to email about a site assignment that has not finished", async () => {
    const current = await completionCurrent();
    await saveTestEmailConfig();
    await storeRows(
      current,
      // The email row is stored first so the outbox hands it out before the
      // assignment it is waiting on.
      [
        {
          data: {
            assignmentKeys: ["registration-email:0"],
            config: {
              fromAddress: validEmail("from@test.com"),
              provider: "resend",
            },
            kind: "site_assignment_email",
            recipient: validEmail("buyer@example.com"),
          },
          key: "site-assignment-email:0",
        },
        ...(await prepareRegistrationEmailDeliveries(
          [makeTestEntry({ id: 1 })],
          "GBP",
        )),
      ],
    );

    try {
      await expect(deliverNextPaidCompletion(current)).rejects.toThrow(
        "has unfinished site assignments",
      );
    } finally {
      settings.clearTestOverrides();
    }
  });
});
