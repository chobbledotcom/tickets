/**
 * Per-field value validators for a listing, over plain string inputs.
 *
 * These are the single definition of "is this listing field value valid" —
 * shared by the HTML form (via the field defs in `#templates/fields.ts`) and by
 * `validateListingInput`, so the form, the admin JSON API, and the catalog
 * import all enforce the same rules. They live in `#shared` (depending only on
 * lightweight shared primitives) so the hot `listings-actions` module can reuse
 * them without pulling in the UI field framework.
 */

import { t } from "#i18n";
import {
  isContactField,
  isListingType,
  MAX_DURATION_DAYS,
} from "#shared/types.ts";

/** Split a comma-separated string into trimmed, non-empty tokens. */
export const splitCsv = (value: string): string[] =>
  value
    .split(",")
    .map((d) => d.trim())
    .filter((d) => d);

/** Valid day names for bookable_days (Monday-first for display). Kept as a
 * literal (rather than derived from `#shared/dates`) so this validator module
 * stays free of the settings-loading import graph and can be reused from the
 * hot `listings-actions` path without perturbing per-request settings caching. */
export const VALID_DAY_NAMES = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
];

/** Check if a string is a valid day name. */
const isValidDayName = (s: string): boolean =>
  (VALID_DAY_NAMES as readonly string[]).includes(s);

/** Validate listing fields setting (comma-separated contact field names). */
export const validateListingFields = (value: string): string | null => {
  for (const part of splitCsv(value)) {
    if (!isContactField(part)) {
      return t("fields.validation.invalid_contact_field", { part });
    }
  }
  return null;
};

/** Validate listing type setting. */
export const validateListingType = (value: string): string | null =>
  isListingType(value) ? null : t("fields.validation.listing_type");

/** Validate bookable days (comma-separated day names). */
export const validateBookableDays = (value: string): string | null => {
  const days = splitCsv(value);
  if (days.length === 0) return t("fields.validation.days_required");
  for (const day of days) {
    if (!isValidDayName(day)) {
      return t("fields.validation.invalid_day", {
        day,
        valid: VALID_DAY_NAMES.join(", "),
      });
    }
  }
  return null;
};

/** Validate a listing's duration (whole days, 1..MAX_DURATION_DAYS). Shared by
 * the form field and the create-input validator, so every create path enforces
 * the same cap rather than silently clamping in the storage layer. Callers pass
 * a non-empty value (the form's validateSingleField guarantees it; the input
 * validator guards undefined itself). */
export const validateDurationDays = (value: string): string | null => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    return t("fields.validation.duration_whole");
  }
  if (parsed < 1) return t("fields.validation.duration_min");
  if (parsed > MAX_DURATION_DAYS) {
    return t("fields.validation.duration_max", { max: MAX_DURATION_DAYS });
  }
  return null;
};

/** The listing fields whose values these validators police (a structural subset
 * of `ListingInput`, so callers pass their input directly). */
export type ListingFieldValues = {
  listingType?: string | undefined;
  bookableDays?: string[] | undefined;
  fields?: string | undefined;
  durationDays?: number | undefined;
};

/**
 * Enforce the per-field value rules the listing form declares (via
 * `getListingFields`), against an already-typed listing input. The HTML form
 * runs these through `validateForm`; the admin JSON API and the catalog import
 * build the input directly and would otherwise bypass them, so running the SAME
 * validators there makes every create path enforce one definition of a valid
 * field value (a bad weekday, contact field, listing type, or over-cap duration
 * is rejected, not silently normalised). Each validator runs only on a present
 * value, mirroring the form's "validate non-empty only" rule so an omitted
 * optional field is never flagged.
 *
 * Datetime fields are deliberately excluded: the form validates the *naive*
 * form value, whereas a typed input's datetimes are already UTC-normalised, so
 * the shared validator's representation wouldn't match. The catalog import
 * validates those at its own (pre-normalisation) schema boundary instead.
 */
export const validateListingFieldValues = (
  input: ListingFieldValues,
): string | null => {
  const bookableDays = (input.bookableDays ?? []).join(",");
  return (
    (input.listingType ? validateListingType(input.listingType) : null) ??
    (bookableDays ? validateBookableDays(bookableDays) : null) ??
    (input.fields ? validateListingFields(input.fields) : null) ??
    (input.durationDays === undefined
      ? null
      : validateDurationDays(String(input.durationDays)))
  );
};
