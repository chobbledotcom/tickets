/**
 * Utilities for reading values from URLSearchParams (form data).
 */

/**
 * Get a form field value as a trimmed string, defaulting to "" when absent.
 */
export const getString = (form: URLSearchParams, key: string): string =>
  form.get(key)?.trim() ?? "";
