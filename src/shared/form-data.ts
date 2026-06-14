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

  /** All values for a repeated field parsed as integers, dropping non-numbers.
   * Useful for checkbox lists that submit multiple values under one name. */
  getNumberArray(key: string): number[] {
    return this.getAll(key)
      .map((v) => Number.parseInt(v, 10))
      .filter((n) => !Number.isNaN(n));
  }
}
