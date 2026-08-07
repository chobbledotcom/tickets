import { computeHmacSha256, hmacToBase64 } from "#shared/payment-crypto.ts";
import type { WebhookEvent } from "#shared/payments.ts";

type SignedTestWebhook = { payload: string; signature: string };

const signedPayload = async (
  notificationUrl: string,
  payload: string,
  secret: string,
): Promise<string> => {
  const data = new TextEncoder().encode(`${notificationUrl}${payload}`);
  return hmacToBase64(await computeHmacSha256(data, secret));
};

export const constructTestWebhookEvent = async (
  listing: WebhookEvent,
  secret: string,
  notificationUrl: string,
): Promise<SignedTestWebhook> => {
  const payload = JSON.stringify(listing);
  const signature = await signedPayload(notificationUrl, payload, secret);
  return { payload, signature };
};
