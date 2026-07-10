/**
 * Field-length limits and helpers for settings whose stored value carries an
 * API-secret prefix. Kept narrow so callers that only need a limit (such as a
 * form field's `maxlength`) don't pull in the whole settings namespace.
 */

export const MAX_WEBSITE_TITLE_LENGTH = 128;
export const MAX_EMAIL_TEMPLATE_LENGTH = 51_200;

/**
 * Classify an API secret by its `sk_test_` / `sk_live_` prefix (Stripe + SumUp
 * share this convention). Empty or unrecognized keys yield null.
 */
export const keyModeOf = (key: string): "test" | "live" | null =>
  key.startsWith("sk_test_")
    ? "test"
    : key.startsWith("sk_live_")
      ? "live"
      : null;
