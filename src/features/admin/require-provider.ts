/**
 * Whether online payments are set up right now.
 *
 * Say plainly that payments are not set up, rather than letting the call to
 * the provider fail and blaming the payment for maybe being refunded.
 */
export const paymentProviderIsConfigured = async (): Promise<boolean> => {
  const { paymentsApi } = await import("#shared/payments.ts");
  return paymentsApi.getConfiguredProvider() !== null;
};
