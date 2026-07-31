import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getDb } from "#shared/db/client.ts";
import {
  applyChargeRefund,
  getPaymentCharges,
  requestChargeRefund,
} from "#shared/db/payments/charges.ts";
import {
  applyPaymentSessionClaim,
  requirePaymentSessionClaim,
} from "#shared/db/payments/claims.ts";
import { storePaymentReconciliation } from "#shared/db/payments/reconcile.ts";
import { createPaymentSession } from "#shared/db/payments/sessions.ts";
import type { PaymentSession } from "#shared/db/payments/types.ts";
import type { PaymentResolution } from "#shared/payment-state/lifecycle.ts";
import type { ProviderRead } from "#shared/payment-state/observation.ts";
import type { ChargeLeg } from "#shared/payment-state/resources.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { savePaymentCharges } from "#test-utils/payment-aggregate.ts";
import {
  chargeLeg,
  PAYMENT_ID,
  PAYMENT_TIME,
  paymentSessionInput,
  READY_RESULT,
  REFUND_RESOURCE,
  SESSION_RESOURCE,
  sessionProgress,
} from "./fixtures.ts";

const pendingRefundPayment = async (
  alreadyRefunded = 0,
): Promise<PaymentSession> => {
  await createPaymentSession(paymentSessionInput(), PAYMENT_TIME);
  const initialClaim = await requirePaymentSessionClaim(PAYMENT_ID, 60_000);
  const payment = await applyPaymentSessionClaim(
    initialClaim,
    sessionProgress({ state: "pending" }),
  );
  await savePaymentCharges(
    PAYMENT_ID,
    SESSION_RESOURCE,
    [
      chargeLeg(
        alreadyRefunded,
        alreadyRefunded === 0
          ? []
          : [
              {
                amount: { amount: alreadyRefunded, currency: "GBP" },
                refund: { ...REFUND_RESOURCE, id: "re_previous" },
                status: "completed",
              },
            ],
      ),
    ],
    PAYMENT_TIME,
  );
  const request = await requestChargeRefund(
    1,
    "persisted-refund-request",
    PAYMENT_TIME,
  );
  await applyChargeRefund(
    1,
    request.idempotencyKey,
    { amount: alreadyRefunded, currency: "GBP" },
    {
      amount: { amount: 1_000, currency: "GBP" },
      refund: REFUND_RESOURCE,
      status: "pending",
    },
    PAYMENT_TIME + 1,
  );
  return payment;
};

const foundRead = (
  charge: ChargeLeg,
): Extract<ProviderRead, { status: "found" }> => ({
  observation: { ...readyObservation(), charges: [charge] },
  requested: SESSION_RESOURCE,
  returned: SESSION_RESOURCE,
  status: "found",
});

const readyObservation = (): Extract<
  PaymentResolution,
  { status: "ready" }
>["observation"] => {
  if (READY_RESULT.status !== "ready") {
    throw new Error("Expected the ready payment fixture");
  }
  return READY_RESULT.observation;
};

const storeRead = async (
  payment: PaymentSession,
  read: ProviderRead,
  resolution: PaymentResolution,
  state: "needs_action" | "processing",
): Promise<void> => {
  const claim = await requirePaymentSessionClaim(PAYMENT_ID, 60_000);
  await storePaymentReconciliation(
    claim,
    payment,
    read,
    resolution,
    sessionProgress({
      result: resolution,
      resultState: resolution.status === "conflict" ? "failed" : "succeeded",
      state,
    }),
    false,
    PAYMENT_TIME + 2,
  );
};

describeWithEnv("db > payments > reconciliation", { db: true }, () => {
  test("keeps pending refund evidence when an ordinary payment read omits it", async () => {
    const payment = await pendingRefundPayment(400);
    const read = foundRead(
      chargeLeg(400, [
        {
          amount: { amount: 400, currency: "GBP" },
          refund: { ...REFUND_RESOURCE, id: "re_previous" },
          status: "completed",
        },
      ]),
    );

    await storeRead(payment, read, READY_RESULT, "processing");

    expect(await getPaymentCharges(PAYMENT_ID)).toMatchObject([
      {
        pendingRefund: REFUND_RESOURCE,
        pendingRefundIdempotencyKey: "persisted-refund-request",
        refunded: { amount: 400, currency: "GBP" },
        refundState: "pending",
      },
    ]);
  });

  test("advances pending evidence when the provider confirms a terminal refund", async () => {
    const payment = await pendingRefundPayment(400);
    const completedCharge = chargeLeg(700, [
      {
        amount: { amount: 300, currency: "GBP" },
        refund: REFUND_RESOURCE,
        status: "completed",
      },
    ]);
    const read = foundRead(completedCharge);
    const resolution: PaymentResolution = {
      issue: { kind: "partial_refund" },
      observation: read.observation,
      resource: SESSION_RESOURCE,
      status: "conflict",
    };

    await storeRead(payment, read, resolution, "needs_action");

    expect(await getPaymentCharges(PAYMENT_ID)).toMatchObject([
      {
        pendingRefund: null,
        pendingRefundIdempotencyKey: null,
        refunded: { amount: 700, currency: "GBP" },
        refundState: "partial",
      },
    ]);
  });
  test("refuses to write the payment down when the lease has moved on", async () => {
    // Two workers can reach a payment at once. The one holding an out-of-date
    // lease must not write its reading over the other's, so the whole write is
    // refused rather than quietly landing on top.
    const payment = await pendingRefundPayment();
    const stale = await requirePaymentSessionClaim(PAYMENT_ID, 60_000);
    await getDb().execute(
      "UPDATE payment_sessions SET lease_expires_at = 0 WHERE id = ?",
      [PAYMENT_ID],
    );
    await requirePaymentSessionClaim(PAYMENT_ID, 60_000);

    await expect(
      storePaymentReconciliation(
        stale,
        payment,
        foundRead(chargeLeg()),
        READY_RESULT,
        sessionProgress({ state: "processing" }),
        false,
        PAYMENT_TIME + 2,
      ),
    ).rejects.toThrow(`Lost payment session lease for ${PAYMENT_ID}`);
  });
});
