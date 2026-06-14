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

  /** A single field parsed as an integer, or null when blank/non-numeric.
   * The shared way to read an optional integer (quantity, line count, …) so
   * callers don't re-implement the parse-and-null-on-NaN dance. */
  getOptionalInt(key: string): number | null {
    const raw = this.getString(key);
    if (raw === "") return null;
    const n = Number.parseInt(raw, 10);
    return Number.isNaN(n) ? null : n;
  }

  /** All values for a repeated field parsed as integers, dropping non-numbers.
   * Useful for checkbox lists that submit multiple values under one name. */
  getNumberArray(key: string): number[] {
    return this.getAll(key)
      .map((v) => Number.parseInt(v, 10))
      .filter((n) => !Number.isNaN(n));
  }
}
