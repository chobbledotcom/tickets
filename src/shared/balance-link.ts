/**
 * Signed, long-lived links a reserved attendee uses to pay their remaining
 * balance. The token carries only the attendee id and an expiry, HMAC-signed
 * over a domain-separated message so it can't be tampered with or collide with
 * any other signed token. The amount due and reserved/paid state are read live
 * from the (plaintext) attendee record, so the public page never needs the
 * private key and the link contains no personal data.
 *
 * Format: bal1.{payloadB64url}.{hmacB64url}  ·  HMAC input: "balance:{payload}"
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

const PREFIX = "bal1.";
const DOMAIN = "balance:";

/** Balance links last 90 days — long enough to be a "pay when you can" link. */
export const BALANCE_LINK_MAX_AGE_S = 90 * 24 * 60 * 60;

/** Payload carried inside a signed balance-payment token. */
export type BalancePayload = {
  /** Attendee id the balance belongs to */
  a: number;
  /** Expiry as unix seconds */
  e: number;
};

const buildMessage = (encoded: string): string => `${DOMAIN}${encoded}`;

/**
 * Sign a balance-payment token for an attendee. Returns "bal1.{payload}.{hmac}".
 */
export const signBalanceToken = (
  attendeeId: number,
  maxAgeSeconds: number = BALANCE_LINK_MAX_AGE_S,
): Promise<string> => {
  const payload: BalancePayload = {
    a: attendeeId,
    e: Math.floor(nowMs() / 1000) + maxAgeSeconds,
  };
  const encoded = encodeTokenPayload(payload);
  return buildSignedToken(PREFIX, encoded, buildMessage(encoded));
};

/**
 * Verify a balance-payment token: prefix, HMAC signature, expiry and
 * clock-skew bounds. Returns the payload on success, or null on any failure.
 */
export const verifyBalanceToken = async (
  token: string,
): Promise<BalancePayload | null> => {
  const encoded = await verifySignedToken(PREFIX, token, buildMessage);
  if (encoded === null) return null;

  const parsed = decodeTokenPayload(encoded);
  if (
    !isTokenObject(parsed) ||
    typeof parsed.a !== "number" ||
    typeof parsed.e !== "number"
  ) {
    return null;
  }
  const payload = parsed as unknown as BalancePayload;

  if (isExpiredNow(payload.e, BALANCE_LINK_MAX_AGE_S)) return null;

  return payload;
};
