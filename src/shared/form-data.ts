/**
 * Utilities for reading values from form data (URLSearchParams).
 */

import type { Result } from "#shared/result.ts";
import {
  parseNonNegativeInt,
  parsePositiveInt as parsePositiveIntId,
} from "#shared/validation/number.ts";

/**
 * URLSearchParams extended with form-specific helpers.
 */
export class FormParams extends URLSearchParams {
  getString(key: string): string {
    return this.get(key)?.trim() ?? "";
  }

  /** A checkbox/flag field: true only when the value is exactly "1" (how the
   * forms submit a ticked box). One home for the "1" convention instead of
   * `getString(key) === "1"` at every call site. */
  getFlag(key: string): boolean {
    return this.getString(key) === "1";
  }

  /** A single field parsed as a strict non-negative integer, or null when blank/invalid. */
  getOptionalInt(key: string): number | null {
    return parseNonNegativeInt(this.getString(key));
  }

  /** All repeated values parsed as strict positive decimal ids, dropping invalid values. */
  getNumberArray(key: string): number[] {
    return this.getAll(key)
      .map(parsePositiveIntId)
      .filter((n) => n !== null);
  }

  /** Validate a repeated field and return selected values in declared order. */
  getRepeatedPicklist<T extends string>(
    key: string,
    allowed: readonly T[],
  ): Result<T[], string> {
    const supplied = this.getAll(key);
    const invalid = supplied.find(
      (value) => !allowed.some((option) => option === value),
    );
    if (invalid !== undefined) return { error: invalid, ok: false };
    const selected = new Set(supplied);
    return { ok: true, value: allowed.filter((value) => selected.has(value)) };
  }

  /** Values for re-rendering a rejected form. Repeated controls use the comma
   * format consumed by checkbox-group fields instead of losing all but one. */
  toRenderValues(): Record<string, string> {
    return Object.fromEntries(
      [...new Set(this.keys())].map((key) => [key, this.getAll(key).join(",")]),
    );
  }
}
