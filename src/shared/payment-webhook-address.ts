// effects: pure
/** The address that a payment provider delivers its callbacks to. */

/** The fixed path under a domain that receives payment callbacks. */
const PAYMENT_WEBHOOK_PATH = "/payment/webhook";

/** Build the public payment webhook URL for the given domain. */
export const paymentWebhookUrl = (domain: string): string =>
  `https://${domain}${PAYMENT_WEBHOOK_PATH}`;
