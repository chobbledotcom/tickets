/* jscpd:ignore-start */
import { settings } from "#db/settings.ts";
import { ErrorCode, logError } from "#shared/logger.ts";
import {
  computeHmacSha256,
  hmacToBase64,
  secureCompare,
} from "#shared/payment-crypto.ts";
import type { WebhookVerifyResult } from "#shared/payments.ts";
import { finishWebhookVerification } from "#shared/webhook-verification.ts";

/* jscpd:ignore-end */

const signedPayload = (
  notificationUrl: string,
  bodyBytes: Uint8Array,
): Uint8Array => {
  const urlBytes = new TextEncoder().encode(notificationUrl);
  const combined = new Uint8Array(urlBytes.length + bodyBytes.length);
  combined.set(urlBytes);
  combined.set(bodyBytes, urlBytes.length);
  return combined;
};

const squareSignature = async (
  data: Uint8Array,
  secret: string,
): Promise<string> => hmacToBase64(await computeHmacSha256(data, secret));

/** Verify Square's HMAC over the registered URL and original request bytes. */
export const verifySquareWebhookSignature = async (
  payload: string,
  signature: string,
  notificationUrl: string,
  payloadBytes: Uint8Array,
): Promise<WebhookVerifyResult> => {
  const secret = settings.square.webhookSignatureKey;
  if (!secret) {
    logError({
      code: ErrorCode.CONFIG_MISSING,
      detail: "Square webhook signature key",
    });
    return { error: "Webhook signature key not configured", valid: false };
  }

  const expectedSignature = await squareSignature(
    signedPayload(notificationUrl, payloadBytes),
    secret,
  );
  const matched = secureCompare(signature, expectedSignature);
  if (!matched) {
    logError({
      code: ErrorCode.SQUARE_SIGNATURE,
      detail: `mismatch: notificationUrl=${notificationUrl}, receivedLength=${signature.length}, expectedLength=${expectedSignature.length}, receivedPrefix=${signature.slice(
        0,
        8,
      )}..., expectedPrefix=${expectedSignature.slice(
        0,
        8,
      )}..., bodyLength=${payloadBytes.length}`,
    });
  }
  return finishWebhookVerification(
    matched,
    payload,
    ErrorCode.SQUARE_SIGNATURE,
  );
};
