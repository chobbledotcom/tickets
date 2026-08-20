/* jscpd:ignore-start */
import type Stripe from "stripe";
import { settings } from "#db/settings.ts";
import { ErrorCode, logError } from "#shared/logger.ts";
import { nowSeconds } from "#shared/now.ts";
import { hmacSha256Hex, secureCompare } from "#shared/payment-crypto.ts";
import type { WebhookEvent, WebhookVerifyResult } from "#shared/payments.ts";
import { finishWebhookVerification } from "#shared/webhook-verification.ts";

/* jscpd:ignore-end */

const DEFAULT_TOLERANCE_SECONDS = 300;

type SignatureParseResult =
  | { ok: true; timestamp: number; signatures: string[] }
  | { ok: false; reason: string };

type HeaderPartResult =
  | { ok: true; key: string; value: string | undefined }
  | { ok: false; reason: string };

type SignatureValuesResult =
  | { ok: true; timestampText: string | undefined; signatures: string[] }
  | { ok: false; reason: string };

const readHeaderPart = (part: string): HeaderPartResult => {
  const separator = part.indexOf("=");
  const key = separator === -1 ? part : part.slice(0, separator);
  if (separator !== part.lastIndexOf("=")) {
    return {
      ok: false,
      reason: key === "t" ? "invalid timestamp" : "invalid signature",
    };
  }
  return {
    key,
    ok: true,
    value: separator === -1 ? undefined : part.slice(separator + 1),
  };
};

const readSignatureValues = (header: string): SignatureValuesResult => {
  let timestampText: string | undefined;
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const parsed = readHeaderPart(part);
    if (!parsed.ok) return parsed;
    const { key, value } = parsed;
    if (key === "t") {
      timestampText = value;
    } else if (key === "v1" && value) {
      signatures.push(value);
    }
  }
  return { ok: true, signatures, timestampText };
};

const validateSignatureValues = (
  values: Extract<SignatureValuesResult, { ok: true }>,
): SignatureParseResult => {
  const { signatures, timestampText } = values;
  if (timestampText === undefined && signatures.length === 0) {
    return { ok: false, reason: "missing timestamp and signature" };
  }
  if (timestampText === undefined) {
    return { ok: false, reason: "missing timestamp" };
  }
  if (signatures.length === 0) {
    return { ok: false, reason: "missing signature" };
  }
  if (!/^\d+$/u.test(timestampText)) {
    return { ok: false, reason: "invalid timestamp" };
  }
  const timestamp = Number(timestampText);
  if (!Number.isSafeInteger(timestamp) || timestamp === 0) {
    return { ok: false, reason: "invalid timestamp" };
  }
  return { ok: true, signatures, timestamp };
};

const parseSignatureHeader = (header: string): SignatureParseResult => {
  const values = readSignatureValues(header);
  return values.ok ? validateSignatureValues(values) : values;
};

export type StripeWebhookEvent = WebhookEvent &
  Pick<Stripe.Event, "id" | "type">;

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
