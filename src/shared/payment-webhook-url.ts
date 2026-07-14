import { getEffectiveDomain } from "#shared/config.ts";

/** The public payment webhook URL for the domain resolved by this request. */
export const getPaymentWebhookUrl = (): string =>
  `https://${getEffectiveDomain()}/payment/webhook`;
