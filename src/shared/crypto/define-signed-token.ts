/**
 * Factory for the app's signed-token schemes. A scheme is `{ sign, verify }`
 * over the primitives in `signed-token.ts`: the QR booking links and the
 * balance-payment links are both instances of it. The factory owns the shared
 * skeleton — encode → HMAC → prefix on the way out, and prefix → HMAC →
 * decode → structural-check → expiry on the way back — so a scheme only
 * declares what actually differs: its prefix, lifetime, HMAC message, and the
 * structural guard for its payload.
 */

import {
  buildSignedToken,
  decodeTokenPayload,
  encodeTokenPayload,
  isExpiredNow,
  isTokenObject,
  verifySignedToken,
} from "#shared/crypto/signed-token.ts";

/** Every signed-token payload carries its expiry as unix seconds. */
export type ExpiringPayload = { e: number };

/**
 * The parts of a signed-token scheme that differ between token types.
 *
 * `Context` is any extra key the HMAC message is bound to beyond the payload
 * itself — a listing slug for QR tokens, nothing (`void`) for balance tokens.
 */
export type SignedTokenScheme<Payload extends ExpiringPayload, Context> = {
  /** Token prefix, e.g. `"qr1."`. Namespaces one scheme's signatures from the
   * next so a token from one type can never verify as another. */
  prefix: string;
  /** Maximum token lifetime in seconds; bounds the accepted expiry on verify. */
  maxAgeS: number;
  /** Domain-separated HMAC input derived from the caller's context and the
   * base64url-encoded payload. */
  message: (context: Context, encoded: string) => string;
  /** Structural guard: narrow a decoded object to `Payload`, or `null` when it
   * does not match the expected shape. */
  parse: (raw: Record<string, unknown>) => Payload | null;
};

/** A `{ sign, verify }` pair produced by {@link defineSignedToken}. */
export type SignedToken<Payload extends ExpiringPayload, Context> = {
  sign: (context: Context, payload: Payload) => Promise<string>;
  verify: (context: Context, token: string) => Promise<Payload | null>;
};

/**
 * Build the `{ sign, verify }` pair for one signed-token scheme.
 *
 * `sign` encodes the payload and appends an HMAC over the scheme's message.
 * `verify` checks the prefix and HMAC, decodes the payload, runs the scheme's
 * structural guard, and enforces the expiry/clock-skew bounds — returning the
 * typed payload on success or `null` on any failure.
 */
export const defineSignedToken = <Payload extends ExpiringPayload, Context>(
  scheme: SignedTokenScheme<Payload, Context>,
): SignedToken<Payload, Context> => {
  const sign = (context: Context, payload: Payload): Promise<string> => {
    const encoded = encodeTokenPayload(payload);
    return buildSignedToken(
      scheme.prefix,
      encoded,
      scheme.message(context, encoded),
    );
  };

  const verify = async (
    context: Context,
    token: string,
  ): Promise<Payload | null> => {
    const encoded = await verifySignedToken(scheme.prefix, token, (e) =>
      scheme.message(context, e),
    );
    if (encoded === null) return null;

    const parsed = decodeTokenPayload(encoded);
    if (!isTokenObject(parsed)) return null;

    const payload = scheme.parse(parsed);
    if (!payload) return null;

    if (isExpiredNow(payload.e, scheme.maxAgeS)) return null;
    return payload;
  };

  return { sign, verify };
};
