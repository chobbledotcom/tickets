import {
  getAdminPaymentProvider,
  type PaymentProvider,
} from "#shared/payments.ts";

/** Uses the existing-payment provider so refunds still work while sales are off. */
export const requirePaymentProvider = async <T>(
  onMissing: () => T,
): Promise<PaymentProvider | T> => {
  const provider = await getAdminPaymentProvider();
  return provider ?? onMissing();
};
