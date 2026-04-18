/**
 * Signed tokens for QR-code pre-filled booking links.
 *
 * A token embeds a small JSON payload (customer name, price, quantity, date,
 * expiry) and an HMAC signature over a domain-separated message so the
 * signature can never collide with CSRF or any other signed token in the app.
 *
 * Format: qr1.{payloadB64url}.{hmacB64url}
 * HMAC input: "qr-book:{slug}:{payloadB64url}"
 */

import { hmacHash } from "#lib/crypto/hashing.ts";
import {
  base64ToBase64Url,
  constantTimeEqual,
  fromBase64,
  toBase64,
} from "#lib/crypto/utils.ts";
import { nowMs } from "#lib/now.ts";

const PREFIX = "qr1.";
const DOMAIN = "qr-book:";

/** QR token expiry in seconds from generation */
export const QR_TOKEN_MAX_AGE_S = 300;

/** Payload carried inside a signed QR booking token */
export type QrBookPayload = {
  /** Customer name to pre-fill (empty string = not provided) */
  n: string;
  /** Price in minor units. -1 = not provided */
  v: number;
  /** Quantity to book (defaults to 1 when creating a token) */
  q: number;
  /** Date for daily events (YYYY-MM-DD). Empty string = not provided */
  d: string;
  /** Expiry as unix seconds */
  e: number;
};

/** Encode bytes to base64url (no padding) */
const bytesToBase64Url = (bytes: Uint8Array): string =>
  base64ToBase64Url(toBase64(bytes));

/** Decode a base64url string to bytes */
const base64UrlToBytes = (s: string): Uint8Array => {
  const padLen = (4 - (s.length % 4)) % 4;
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat(padLen);
  return fromBase64(b64);
};

/** Encode payload JSON as base64url */
const encodePayload = (payload: QrBookPayload): string => {
  const json = JSON.stringify(payload);
  return bytesToBase64Url(new TextEncoder().encode(json));
};

/** Decode payload JSON from base64url. Returns null on any decode failure. */
const decodePayload = (encoded: string): QrBookPayload | null => {
  try {
    const bytes = base64UrlToBytes(encoded);
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      typeof parsed.n !== "string" ||
      typeof parsed.v !== "number" ||
      typeof parsed.q !== "number" ||
      typeof parsed.d !== "string" ||
      typeof parsed.e !== "number"
    ) {
      return null;
    }
    return parsed as QrBookPayload;
  } catch {
    return null;
  }
};

/** Build the domain-separated HMAC input for a token */
const buildMessage = (slug: string, encodedPayload: string): string =>
  `${DOMAIN}${slug}:${encodedPayload}`;

/**
 * Build a payload ready for signing.
 * Fills defaults and computes the expiry timestamp.
 */
export const buildQrBookPayload = (input: {
  name?: string;
  value?: number;
  quantity?: number;
  date?: string;
  maxAgeSeconds?: number;
}): QrBookPayload => {
  const maxAge = input.maxAgeSeconds ?? QR_TOKEN_MAX_AGE_S;
  return {
    d: input.date ?? "",
    e: Math.floor(nowMs() / 1000) + maxAge,
    n: input.name ?? "",
    q: input.quantity ?? 1,
    v: input.value ?? -1,
  };
};

/**
 * Sign a QR booking payload for the given event slug.
 * Returns the encoded token "qr1.{payload}.{hmac}".
 */
export const signQrBookToken = async (
  slug: string,
  payload: QrBookPayload,
): Promise<string> => {
  const encoded = encodePayload(payload);
  const message = buildMessage(slug, encoded);
  const hmac = base64ToBase64Url(await hmacHash(message));
  return `${PREFIX}${encoded}.${hmac}`;
};

/**
 * Verify a QR booking token for the given event slug.
 * Checks the prefix, HMAC signature, expiry, and clock-skew bounds.
 * Returns the decoded payload on success, or null on any failure.
 */
export const verifyQrBookToken = async (
  slug: string,
  token: string,
): Promise<QrBookPayload | null> => {
  if (!token.startsWith(PREFIX)) return null;
  const rest = token.slice(PREFIX.length);
  const dotIndex = rest.indexOf(".");
  if (dotIndex <= 0 || dotIndex === rest.length - 1) return null;

  const encoded = rest.slice(0, dotIndex);
  const providedHmac = rest.slice(dotIndex + 1);

  const expected = base64ToBase64Url(
    await hmacHash(buildMessage(slug, encoded)),
  );
  if (!constantTimeEqual(expected, providedHmac)) return null;

  const payload = decodePayload(encoded);
  if (!payload) return null;

  const nowS = Math.floor(nowMs() / 1000);
  // Reject expired and future-dated tokens (60s clock skew tolerance)
  if (payload.e < nowS) return null;
  if (payload.e - nowS > QR_TOKEN_MAX_AGE_S + 60) return null;

  return payload;
};
