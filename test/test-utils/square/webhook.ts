import { computeHmacSha256, hmacToBase64 } from "#shared/payment-crypto.ts";
import type { WebhookEvent } from "#shared/payments.ts";

type SignedSquareWebhook = { payload: string; signature: string };

/** Sign a Square webhook fixture with the registered notification URL. */
export const constructTestWebhookEvent = async (
  listing: WebhookEvent,
  secret: string,
  notificationUrl: string,
): Promise<SignedSquareWebhook> => {
  const payload = JSON.stringify(listing);
  const signature = hmacToBase64(
    await computeHmacSha256(
      new TextEncoder().encode(notificationUrl + payload),
      secret,
    ),
  );
  return { payload, signature };
};
