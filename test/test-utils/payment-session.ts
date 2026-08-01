import {
  isSessionRejection,
  type SessionRejection,
} from "#shared/payment/validated-session.ts";
import type { ValidatedPaymentSession } from "#shared/payments.ts";

/** Narrow a provider session result to the session; fail the test on a rejection or null. */
export const asSession = (
  result: ValidatedPaymentSession | SessionRejection | null,
): ValidatedPaymentSession => {
  if (result === null || isSessionRejection(result)) {
    throw new Error(`expected a session, got ${JSON.stringify(result)}`);
  }
  return result;
};
