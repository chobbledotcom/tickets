import type {
  PreparedPaymentCompletionDelivery,
  RegistrationWebhookDelivery,
} from "#shared/payment-completion-delivery.ts";
import { isSafeServerFetchUrl } from "#shared/url-safety.ts";
import {
  postRegistrationWebhook,
  type RegistrationEntry,
  registrationWebhookRequests,
  type WebhookPayload,
} from "#shared/webhook.ts";

export const sendWebhookStrict = async (
  webhookUrl: string,
  payload: WebhookPayload,
): Promise<void> => {
  if (!isSafeServerFetchUrl(webhookUrl)) {
    throw new Error("Refused to send webhook to an unsafe URL");
  }
  const result = await postRegistrationWebhook(webhookUrl, payload);
  if (!result.ok) {
    throw new Error(`Webhook delivery failed with status ${result.status}`);
  }
};

export const prepareRegistrationWebhookDeliveries = async (
  entries: RegistrationEntry[],
  currency: string,
): Promise<PreparedPaymentCompletionDelivery[]> => {
  const requests = await registrationWebhookRequests(entries, currency);
  return requests.map(({ listingId, payload, url }, index) => ({
    data: {
      kind: "registration_webhook" as const,
      listingId,
      payload,
      url,
    },
    key: `registration-webhook:${index}`,
  }));
};

export const sendPreparedRegistrationWebhook = (
  delivery: RegistrationWebhookDelivery,
): Promise<void> => sendWebhookStrict(delivery.url, delivery.payload);
