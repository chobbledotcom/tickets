/**
 * Utilities for reading values from form data (URLSearchParams).
 */

/**
 * URLSearchParams extended with form-specific helpers.
 */
export class FormParams extends URLSearchParams {
  getString(key: string): string {
    return this.get(key)?.trim() ?? "";
  }
}
