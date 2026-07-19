import { settings } from "#shared/db/settings.ts";
import { ErrorCode, logError } from "#shared/logger.ts";
import { nowSeconds } from "#shared/now.ts";
import { hmacSha256Hex, secureCompare } from "#shared/payment-crypto.ts";
import {
  type SignedTestWebhook,
  signedTestWebhook,
} from "#shared/payment-helpers.ts";
import type { WebhookEvent, WebhookVerifyResult } from "#shared/payments.ts";
import { finishWebhookVerification } from "#shared/webhook-verification.ts";

const DEFAULT_TOLERANCE_SECONDS = 300;

type SignatureParseResult =
  | { ok: true; timestamp: number; signatures: string[] }
  | { ok: false; reason: string };

const parseSignatureHeader = (header: string): SignatureParseResult => {
  const parts = header.split(",");
  let timestamp = 0;
  const signatures: string[] = [];
  for (const part of parts) {
    const [key, value] = part.split("=");
    if (key === "t" && value) {
      timestamp = Number.parseInt(value, 10);
    } else if (key === "v1" && value) {
      signatures.push(value);
    }
  }
  if (timestamp === 0 && signatures.length === 0) {
    return { ok: false, reason: "missing timestamp and signature" };
  }
  if (timestamp === 0) return { ok: false, reason: "missing timestamp" };
  if (signatures.length === 0) {
    return { ok: false, reason: "missing signature" };
  }
  return { ok: true, signatures, timestamp };
};

export type StripeWebhookEvent = WebhookEvent;

/** Verify a Stripe webhook signature with edge-compatible Web Crypto. */
export const verifyWebhookSignature = async (
  payload: string,
  signature: string,
  toleranceSeconds = DEFAULT_TOLERANCE_SECONDS,
): Promise<WebhookVerifyResult> => {
  const secret = settings.stripe.webhookSecret;
  if (!secret) {
    logError({ code: ErrorCode.CONFIG_MISSING, detail: "webhook secret" });
    return { error: "Webhook secret not configured", valid: false };
  }
  const parsed = parseSignatureHeader(signature);
  if (!parsed.ok) {
    logError({
      code: ErrorCode.STRIPE_SIGNATURE,
      detail: `invalid header: ${parsed.reason}`,
    });
    return { error: "Invalid signature header format", valid: false };
  }
  const timestampDelta = nowSeconds() - parsed.timestamp;
  if (Math.abs(timestampDelta) > toleranceSeconds) {
    logError({
      code: ErrorCode.STRIPE_SIGNATURE,
      detail: `timestamp out of tolerance delta=${timestampDelta}s tolerance=${toleranceSeconds}s`,
    });
    return { error: "Timestamp outside tolerance window", valid: false };
  }
  const expected = await hmacSha256Hex(
    `${parsed.timestamp}.${payload}`,
    secret,
  );
  const valid = parsed.signatures.some((candidate) =>
    secureCompare(candidate, expected),
  );
  if (!valid) {
    logError({ code: ErrorCode.STRIPE_SIGNATURE, detail: "mismatch" });
  }
  return finishWebhookVerification(valid, payload, ErrorCode.STRIPE_SIGNATURE);
};

export const constructTestWebhookEvent = (
  event: StripeWebhookEvent,
  secret: string,
): Promise<SignedTestWebhook> =>
  signedTestWebhook(event, async (payload) => {
    const timestamp = nowSeconds();
    const signature = await hmacSha256Hex(`${timestamp}.${payload}`, secret);
    return `t=${timestamp},v1=${signature}`;
  });
