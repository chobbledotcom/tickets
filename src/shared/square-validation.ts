/**
 * Square credential format validation.
 *
 * These are cheap, offline "is this clearly the wrong value" checks run before
 * saving Square settings. They cannot prove a credential is correct (only a
 * live API / webhook round-trip can), but they catch the common setup mistakes
 * — most often pasting a value into the wrong field, e.g. an access token into
 * the webhook signature key box, which surfaces later as an
 * E_SQUARE_SIGNATURE webhook rejection.
 *
 * All functions return a human-readable error string, or null when the value
 * passes the format check.
 */

/** Square access tokens (production and sandbox) begin with this prefix. */
export const SQUARE_ACCESS_TOKEN_PREFIX = "EAAA";

/**
 * Square application IDs/secrets begin with one of these prefixes
 * (e.g. `sq0idp-`, `sq0csp-`, `sandbox-sq0idb-`).
 */
const APP_CREDENTIAL_PREFIXES = ["sq0", "sandbox-sq0"] as const;

/** Example Location ID used in hints (matches Square's format). */
const EXAMPLE_LOCATION_ID = "LH182V1KBR6V2";

/** True when the value looks like a Square access token. */
const looksLikeAccessToken = (value: string): boolean =>
  value.startsWith(SQUARE_ACCESS_TOKEN_PREFIX);

/** True when the value looks like a Square application ID or secret. */
const looksLikeAppCredential = (value: string): boolean =>
  APP_CREDENTIAL_PREFIXES.some((prefix) => value.startsWith(prefix));

/**
 * Validate a Square access token's format.
 * Rejects application IDs/secrets and anything missing the `EAAA` prefix.
 */
export const validateSquareAccessToken = (token: string): string | null => {
  if (looksLikeAppCredential(token)) {
    return 'That looks like a Square application ID or secret (it starts with "sq0"), not an access token. Copy the Access Token from your Square application\'s Credentials page.';
  }
  if (!looksLikeAccessToken(token)) {
    return `Square access tokens start with "${SQUARE_ACCESS_TOKEN_PREFIX}". Please check you pasted the Access Token, not the Application ID or a webhook signature key.`;
  }
  return null;
};

/**
 * Validate a Square Location ID's format.
 * Location IDs are short codes like LH182V1KBR6V2; we only reject the values
 * that clearly belong in a different field (an access token or application ID)
 * rather than enforcing an exact shape, to avoid rejecting valid IDs.
 */
export const validateSquareLocationId = (locationId: string): string | null => {
  if (looksLikeAccessToken(locationId)) {
    return `That looks like an access token, not a Location ID. The Location ID is a short code like "${EXAMPLE_LOCATION_ID}" found under Locations in your Square Dashboard.`;
  }
  if (looksLikeAppCredential(locationId)) {
    return `That looks like a Square application ID, not a Location ID. The Location ID is a short code like "${EXAMPLE_LOCATION_ID}" found under Locations in your Square Dashboard.`;
  }
  return null;
};

/**
 * Validate a Square webhook signature key's format.
 * Catches the common mistake of pasting an access token or application ID
 * into the signature key field (the cause of E_SQUARE_SIGNATURE rejections).
 */
export const validateSquareWebhookSignatureKey = (
  key: string,
): string | null => {
  if (looksLikeAccessToken(key)) {
    return "That looks like an access token, not a webhook signature key. Copy the Signature Key shown on your webhook subscription page in the Square Developer Dashboard.";
  }
  if (looksLikeAppCredential(key)) {
    return "That looks like a Square application ID, not a webhook signature key. Copy the Signature Key shown on your webhook subscription page in the Square Developer Dashboard.";
  }
  return null;
};
