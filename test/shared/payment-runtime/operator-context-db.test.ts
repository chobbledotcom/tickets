import { expect } from "@std/expect";
import { afterEach, it as test } from "@std/testing/bdd";
import { recordPaymentCase } from "#shared/db/payments/cases.ts";
import { settings } from "#shared/db/settings.ts";
import { getPaymentOperatorCase } from "#shared/payment-runtime/operator-context.ts";
import {
  PAYMENT_INTENT,
  PAYMENT_TIME,
  SESSION_RESOURCE,
} from "#test/shared/db/payments/fixtures.ts";
import { createPendingPayment } from "#test/shared/payment-runtime/fixtures.ts";
import { describeWithEnv } from "#test-utils/db.ts";

const recordCase = (paymentId: string, resourceId = SESSION_RESOURCE.id) =>
  recordPaymentCase(
    {
      evidence: PAYMENT_INTENT,
      nextReconcileAt: null,
      paymentId,
      reason: "partial_refund",
      resource: { ...SESSION_RESOURCE, id: resourceId },
      state: "needs_action",
    },
    PAYMENT_TIME,
  );

describeWithEnv("payment operator case loading", { db: true }, () => {
  afterEach(() => settings.clearTestOverrides());

  test("returns null when the case does not exist", async () => {
    expect(await getPaymentOperatorCase(999_999)).toBeNull();
  });

  test("loads a current payment for its case", async () => {
    const payment = await createPendingPayment();
    const paymentCase = (await recordCase(payment.id)).paymentCase;

    expect(await getPaymentOperatorCase(paymentCase.id)).toMatchObject({
      payment: { origin: "current", value: { id: payment.id } },
    });
  });

  test("fails when a case has no current or older payment", async () => {
    const paymentCase = (await recordCase("missing-payment", "missing-session"))
      .paymentCase;

    await expect(getPaymentOperatorCase(paymentCase.id)).rejects.toThrow(
      `Payment case ${paymentCase.id} has no payment`,
    );
  });
});
