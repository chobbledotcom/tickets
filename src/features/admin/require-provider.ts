import {
  getPaymentProviderForExistingPayments,
  type PaymentProvider,
} from "#shared/payments.ts";

/** The provider for refunding or refreshing an existing payment, or the
 * caller's `onMissing` fallback (a redirect or error Response) when none was
 * ever configured. Uses {@link getPaymentProviderForExistingPayments} so an
 * operator can still refund and reconcile after switching new sales off. The
 * refund and refresh POSTs share this "need a provider before we touch money"
 * guard instead of each re-checking. */
export const requirePaymentProvider = async <T>(
  onMissing: () => T,
): Promise<PaymentProvider | T> => {
  const provider = await getPaymentProviderForExistingPayments();
  return provider ?? onMissing();
};
