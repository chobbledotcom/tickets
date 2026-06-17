/**
 * Utilities for reading values from form data (URLSearchParams).
 */

import {
  parseNonNegativeInt,
  parsePositiveIntId,
} from "#shared/validation/number.ts";

/**
 * URLSearchParams extended with form-specific helpers.
 */
export class FormParams extends URLSearchParams {
  getString(key: string): string {
    return this.get(key)?.trim() ?? "";
  }

  /** A single field parsed as a strict non-negative integer, or null when blank/invalid. */
  getOptionalInt(key: string): number | null {
    const raw = this.getString(key);
    return raw === "" ? null : parseNonNegativeInt(raw);
  }

  /** All repeated values parsed as strict positive decimal ids, dropping invalid values. */
  getNumberArray(key: string): number[] {
    return this.getAll(key)
      .map(parsePositiveIntId)
      .filter((n) => n !== null);
  }
}
