import type { FakeTime } from "@std/testing/time";
import type { PaymentSession } from "#shared/db/payments/types.ts";
import { refundCharges } from "#shared/payment-runtime/refund.ts";
import { PAYMENT_TIME } from "#test/shared/db/payments/fixtures.ts";

export const retryRefundUntilStopped = async (
  time: FakeTime,
  payment: PaymentSession,
): Promise<PaymentSession> => {
  let current = payment;
  for (const elapsed of [0, 60_000, 15 * 60_000]) {
    time.tick(elapsed - (Date.now() - PAYMENT_TIME));
    current = (await refundCharges(current)).payment;
  }
  return current;
};
