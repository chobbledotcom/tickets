export type RefundPaymentReference = {
  readonly providerRefunded: boolean;
  readonly reference: string;
  readonly sessionIds: readonly string[];
};
