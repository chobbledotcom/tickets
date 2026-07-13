import {
  getActivePaymentProvider,
  type PaymentProvider,
} from "#shared/payments.ts";

/** The active payment provider, or the caller's `onMissing` fallback (a redirect
 * or error Response) when none is configured. The refund and refresh POSTs share
 * this "need a provider before we touch money" guard instead of each re-checking. */
export const requirePaymentProvider = async <T>(
  onMissing: () => T,
): Promise<PaymentProvider | T> => {
  const provider = await getActivePaymentProvider();
  return provider ?? onMissing();
};
