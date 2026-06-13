/**
 * Square credential format validation.
 *
 * These are cheap, offline "is this clearly the wrong value" checks run before
 * saving Square settings. They cannot prove a credential is correct (only a
 * live API / webhook round-trip via the Test Connection button can), but they
 * catch the common setup mistakes — most often pasting a value into the wrong
 * field, e.g. an access token into the webhook signature key box, which
 * surfaces later as an E_SQUARE_SIGNATURE webhook rejection.
 *
 * Design notes (why these checks are shaped the way they are):
 * - Access token: Square has used several formats — legacy personal access
 *   tokens (`sq0atp-`), the current `EAAA…` style, and opt-in JWT tokens
 *   (`eyJ…`, via use_jwt). Square advises against validating by format, so the
 *   regex below is a deliberately permissive allowlist of every known prefix
 *   with no length bound; it only rejects values that match none of them.
 * - Location ID / webhook signature key: these are only checked against the
 *   application ID/secret namespace, which they can never legitimately occupy.
 *   We do NOT try to positively assert their shape (locations and signature
 *   keys are opaque), so valid values are never blocked.
 *
 * All functions return a human-readable error string, or null when the value
 * passes the format check.
 */

/**
 * Application ID/secret prefixes. These namespaces are distinct from access
 * tokens, location IDs, and webhook keys, so a value starting with one of
 * these in any of those fields is unambiguously the wrong credential.
 * (Note: legacy access tokens are `sq0atp-`, which is intentionally NOT here.)
 */
const APP_CREDENTIAL_PREFIXES = [
  "sq0idp-", // application ID (production)
  "sandbox-sq0idb-", // application ID (sandbox)
  "sq0csp-", // application secret (production)
  "sandbox-sq0csb-", // application secret (sandbox)
] as const;

/**
 * Allowlist of every Square access token format we know of. Permissive by
 * design — Square does not guarantee token format, so we accept all known
 * prefixes (current, legacy, and JWT) with no length limit and only reject
 * values that look like nothing Square issues.
 */
const ACCESS_TOKEN_PATTERN =
  /^(EAAA|sq0atp-|sandbox-sq0atp-|eyJ)[0-9A-Za-z._-]+$/;

/** Example Location ID used in hints (matches Square's format). */
const EXAMPLE_LOCATION_ID = "LH182V1KBR6V2";

/** True when the value looks like a Square application ID or secret. */
const looksLikeAppCredential = (value: string): boolean =>
  APP_CREDENTIAL_PREFIXES.some((prefix) => value.startsWith(prefix));

/**
 * Validate a Square access token's format.
 * Rejects application IDs/secrets and anything that matches no known token
 * format (current `EAAA…`, legacy `sq0atp-…`, or JWT `eyJ…`).
 */
export const validateSquareAccessToken = (token: string): string | null => {
  if (looksLikeAppCredential(token)) {
    return 'That looks like a Square application ID or secret (it starts with "sq0"), not an access token. Copy the Access Token from your Square application\'s Credentials page.';
  }
  if (!ACCESS_TOKEN_PATTERN.test(token)) {
    return 'That doesn\'t look like a Square access token. Access tokens start with "EAAA" or "eyJ". Please check you pasted the Access Token, not the Application ID or a webhook signature key.';
  }
  return null;
};

/**
 * Validate a Square Location ID's format.
 * Location IDs are opaque short codes like LH182V1KBR6V2, so we only reject a
 * pasted application ID/secret rather than asserting an exact shape.
 */
export const validateSquareLocationId = (locationId: string): string | null => {
  if (looksLikeAppCredential(locationId)) {
    return `That looks like a Square application ID or secret, not a Location ID. The Location ID is a short code like "${EXAMPLE_LOCATION_ID}" found under Locations in your Square Dashboard.`;
  }
  return null;
};

/**
 * Validate a Square webhook signature key's format.
 * Signature keys are opaque, so we only reject a pasted application ID/secret
 * (a wrong-credential mistake) rather than asserting an exact shape.
 */
export const validateSquareWebhookSignatureKey = (
  key: string,
): string | null => {
  if (looksLikeAppCredential(key)) {
    return "That looks like a Square application ID or secret, not a webhook signature key. Copy the Signature Key shown on your webhook subscription page in the Square Developer Dashboard.";
  }
  return null;
};
