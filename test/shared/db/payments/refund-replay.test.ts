import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  applyChargeRefund,
  requestChargeRefund,
} from "#shared/db/payments/charges.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { savePaymentCharges } from "#test-utils/payment-aggregate.ts";
import { pendingRefundObservation } from "#test-utils/payment-refunds.ts";
import {
  chargeLeg,
  PAYMENT_ID,
  PAYMENT_TIME,
  REFUND_RESOURCE,
  SESSION_RESOURCE,
} from "./fixtures.ts";

const storedRefundRequest = async (): Promise<
  Awaited<ReturnType<typeof requestChargeRefund>>
> => {
  await savePaymentCharges(
    PAYMENT_ID,
    SESSION_RESOURCE,
    [chargeLeg()],
    PAYMENT_TIME,
  );
  return requestChargeRefund(1, "stable-refund-request", PAYMENT_TIME);
};

describeWithEnv("db > payments > refund replay", { db: true }, () => {
  test("keeps the exact pending resource when a later check omits it", async () => {
    const request = await storedRefundRequest();
    await applyChargeRefund(
      1,
      request.idempotencyKey,
      { amount: 0, currency: "GBP" },
      pendingRefundObservation(REFUND_RESOURCE),
      PAYMENT_TIME + 1,
    );

    const checked = await applyChargeRefund(
      1,
      request.idempotencyKey,
      { amount: 0, currency: "GBP" },
      { amount: { amount: 1_000, currency: "GBP" }, status: "pending" },
      PAYMENT_TIME + 2,
    );

    expect(checked).toMatchObject({
      pendingRefund: REFUND_RESOURCE,
      pendingRefundIdempotencyKey: request.idempotencyKey,
      refundState: "pending",
    });
    expect(
      await requestChargeRefund(1, "new-request", PAYMENT_TIME + 3),
    ).toEqual(request);
  });

  test("keeps one request identity after a failed provider result", async () => {
    const request = await storedRefundRequest();

    const failed = await applyChargeRefund(
      1,
      request.idempotencyKey,
      { amount: 0, currency: "GBP" },
      {
        amount: { amount: 0, currency: "GBP" },
        reason: "provider_failed",
        refund: REFUND_RESOURCE,
        status: "failed",
      },
      PAYMENT_TIME + 1,
    );

    expect(failed).toMatchObject({
      pendingRefund: null,
      pendingRefundIdempotencyKey: request.idempotencyKey,
      refunded: { amount: 0, currency: "GBP" },
      refundState: "failed",
    });
    expect(
      await requestChargeRefund(1, "replacement-request", PAYMENT_TIME + 2),
    ).toEqual(request);
  });
});
