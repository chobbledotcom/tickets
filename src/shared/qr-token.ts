/**
 * Signed tokens for QR-code pre-filled booking links.
 *
 * A token embeds a small JSON payload (customer name, price, quantity, date,
 * expiry) and an HMAC signature over a domain-separated message. The
 * signature can never collide with CSRF or any other signed token in the app.
 *
 * Format: qr1.{payloadB64url}.{hmacB64url}
 * HMAC input: "qr-book:{slug}:{payloadB64url}"
 */

import * as v from "valibot";
/* jscpd:ignore-start -- imports */
import { defineSignedToken } from "#crypto/define-signed-token.ts";
import { expiresIn } from "#shared/now.ts";
import { parseOrNull } from "#shared/validation/parse.ts";
/* jscpd:ignore-end */

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

const QrBookPayloadSchema = v.strictObject({
  d: v.string(),
  e: v.number(),
  n: v.string(),
  q: v.number(),
  v: v.number(),
});

/** The QR scheme: HMAC message is keyed by the listing slug. */
const qrToken = defineSignedToken<QrBookPayload, string>({
  maxAgeS: QR_TOKEN_MAX_AGE_S,
  message: (slug, encoded) => `qr-book:${slug}:${encoded}`,
  parse: (raw) => parseOrNull(QrBookPayloadSchema, raw),
  prefix: "qr1.",
});

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
    e: expiresIn(maxAge),
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
): Promise<string> => qrToken.sign(slug, payload);

/**
 * Verify a QR booking token for the given listing slug.
 * Checks the prefix, HMAC signature, expiry, and clock-skew bounds.
 * Returns the decoded payload on success, or null on any failure.
 */
export const verifyQrBookToken = (
  slug: string,
  token: string,
): Promise<QrBookPayload | null> => qrToken.verify(slug, token);
