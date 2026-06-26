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

// jscpd:ignore-start
import {
  buildSignedToken,
  decodeTokenPayload,
  encodeTokenPayload,
  isExpiredNow,
  isTokenObject,
  verifySignedToken,
} from "#shared/crypto/signed-token.ts";
import { nowMs } from "#shared/now.ts";

// jscpd:ignore-end

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
  /** Date for daily listings (YYYY-MM-DD). Empty string = not provided */
  d: string;
  /** Expiry as unix seconds */
  e: number;
};

/** Decode payload JSON from base64url. Returns null on any decode failure. */
const decodePayload = (encoded: string): QrBookPayload | null => {
  const parsed = decodeTokenPayload(encoded);
  if (
    !isTokenObject(parsed) ||
    typeof parsed.n !== "string" ||
    typeof parsed.v !== "number" ||
    typeof parsed.q !== "number" ||
    typeof parsed.d !== "string" ||
    typeof parsed.e !== "number"
  ) {
    return null;
  }
  return parsed as unknown as QrBookPayload;
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
 * Sign a QR booking payload for the given listing slug.
 * Returns the encoded token "qr1.{payload}.{hmac}".
 */
export const signQrBookToken = (
  slug: string,
  payload: QrBookPayload,
): Promise<string> => {
  const encoded = encodeTokenPayload(payload);
  return buildSignedToken(PREFIX, encoded, buildMessage(slug, encoded));
};

/**
 * Verify a QR booking token for the given listing slug.
 * Checks the prefix, HMAC signature, expiry, and clock-skew bounds.
 * Returns the decoded payload on success, or null on any failure.
 */
export const verifyQrBookToken = async (
  slug: string,
  token: string,
): Promise<QrBookPayload | null> => {
  const encoded = await verifySignedToken(PREFIX, token, (e) =>
    buildMessage(slug, e),
  );
  if (encoded === null) return null;

  const payload = decodePayload(encoded);
  if (!payload) return null;

  if (isExpiredNow(payload.e, QR_TOKEN_MAX_AGE_S)) return null;

  return payload;
};
