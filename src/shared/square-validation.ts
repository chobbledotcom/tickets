/**
 * Catches a Square credential pasted into the wrong settings field. Only the
 * Test Connection button can prove that a credential is correct.
 *
 * Square used several access-token formats and advises against validation by
 * format, so the prefix allowlist is deliberately permissive and sets no length
 * bound. Location ids and signature keys are opaque, so they are checked only
 * against the application id namespace they can never occupy.
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
