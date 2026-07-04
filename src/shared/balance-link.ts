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

import { defineSignedToken } from "#shared/crypto/define-signed-token.ts";
import { nowMs } from "#shared/now.ts";

/** Balance links last 90 days — long enough to be a "pay when you can" link. */
export const BALANCE_LINK_MAX_AGE_S = 90 * 24 * 60 * 60;

/** Payload carried inside a signed balance-payment token. */
export type BalancePayload = {
  /** Attendee id the balance belongs to */
  a: number;
  /** Expiry as unix seconds */
  e: number;
};

/** The balance scheme: the HMAC message is bound to the payload alone. */
const balanceToken = defineSignedToken<BalancePayload, void>({
  maxAgeS: BALANCE_LINK_MAX_AGE_S,
  message: (_context, encoded) => `balance:${encoded}`,
  parse: (parsed) =>
    typeof parsed.a === "number" && typeof parsed.e === "number"
      ? (parsed as unknown as BalancePayload)
      : null,
  prefix: "bal1.",
});

/**
 * Sign a balance-payment token for an attendee. Returns "bal1.{payload}.{hmac}".
 */
export const signBalanceToken = (
  attendeeId: number,
  maxAgeSeconds: number = BALANCE_LINK_MAX_AGE_S,
): Promise<string> =>
  balanceToken.sign(undefined, {
    a: attendeeId,
    e: Math.floor(nowMs() / 1000) + maxAgeSeconds,
  });

/**
 * Verify a balance-payment token: prefix, HMAC signature, expiry and
 * clock-skew bounds. Returns the payload on success, or null on any failure.
 */
export const verifyBalanceToken = (
  token: string,
): Promise<BalancePayload | null> => balanceToken.verify(undefined, token);
