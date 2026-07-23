import {
  claimPaymentRefundAttempt,
  releasePaymentRefundAttempt,
} from "#shared/db/payment-refund-attempts.ts";
import { ErrorCode, logDebug, logError } from "#shared/logger.ts";
import type { PaymentProvider, PaymentRefundResult } from "#shared/payments.ts";

export type RefundProvider = Pick<
  PaymentProvider,
  "inspectPaymentRefund" | "refundPayment" | "refundRetryMode" | "type"
>;

const inspectPaymentRefund =
  (provider: RefundProvider) =>
  async (paymentReference: string): Promise<PaymentRefundResult> => {
    try {
      return await provider.inspectPaymentRefund(paymentReference);
    } catch (error) {
      if (provider.refundRetryMode === "idempotent") throw error;
      logError({
        code: ErrorCode.PAYMENT_REFUND,
        detail: `Could not inspect ${provider.type} refund ${paymentReference}: ${String(error)}`,
      });
      return "pending";
    }
  };

/** Submit one provider refund, or inspect the durable attempt when POST retries
 * are unsafe. A non-idempotent uncertain result stays pending until its status
 * can be proved; it is never submitted a second time. */
export const refundPaymentAtProvider = async (
  provider: RefundProvider,
  paymentReference: string,
): Promise<PaymentRefundResult> => {
  if (paymentReference === "") return "failed";
  const inspectAfterFirst = provider.refundRetryMode === "inspect-after-first";
  if (
    inspectAfterFirst &&
    !(await claimPaymentRefundAttempt(provider.type, paymentReference))
  ) {
    const result = await inspectPaymentRefund(provider)(paymentReference);
    if (result === "failed") {
      await releasePaymentRefundAttempt(provider.type, paymentReference);
    }
    return result;
  }

  let result: PaymentRefundResult;
  try {
    result = await provider.refundPayment(paymentReference);
  } catch (error) {
    if (!inspectAfterFirst) throw error;
    logError({
      code: ErrorCode.PAYMENT_REFUND,
      detail: `Uncertain ${provider.type} refund submission ${paymentReference}: ${String(error)}`,
    });
    return "pending";
  }
  if (result === "refunded") {
    logDebug("Payment", "Refund issued");
    return result;
  }
  if (result === "pending") return result;
  if ((await inspectPaymentRefund(provider)(paymentReference)) === "refunded") {
    logDebug("Payment", "Payment already fully refunded");
    return "refunded";
  }
  if (inspectAfterFirst) {
    await releasePaymentRefundAttempt(provider.type, paymentReference);
  }
  return "failed";
};
