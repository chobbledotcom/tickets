/**
 * Pure validators and small field builders shared across the form-field modules.
 *
 * Everything here is data-in/data-out: no settings reads, no HTTP. The few
 * field builders (`getUsernameFieldBase`, `buildDescriptionField`,
 * `buildHiddenField`) are shared because more than one form needs the same
 * field, and a builder keeps them from drifting.
 */

/* jscpd:ignore-start */
import * as v from "valibot";
import { t } from "#i18n";
import { VALID_DAY_NAMES } from "#shared/day-names.ts";
import { isUpdateTier } from "#shared/db/built-sites.ts";
import type {
  ChoiceField,
  Field,
  InputField,
  TextareaField,
} from "#shared/forms/field.ts";
import { MAX_TEXTAREA_LENGTH } from "#shared/limits.ts";
import {
  firstIssueMessage,
  normalizeSlug,
  validateSlug,
} from "#shared/slug.ts";
import { isValidDatetime } from "#shared/timezone.ts";
import { isContactField } from "#shared/types.ts";
import { validateSafeServerFetchUrl } from "#shared/url-safety.ts";
import { isIsoDate } from "#shared/validation/date.ts";
import { EmailFormatSchema } from "#shared/validation/email.ts";
import { parseOptionalMinorUnits } from "#shared/validation/money.ts";
/* jscpd:ignore-end */

/**
 * Validate a user-saved URL that must point at a public https:// domain.
 */
export const validateHttpsDomainUrl = (value: string): string | null =>
  validateSafeServerFetchUrl(value, t("fields.validation.url_https"));

/**
 * Validate a required non-negative price. Currency-aware: rejects a blank, a
 * negative, a non-numeric value, AND an amount carrying more decimal places than
 * the active currency allows (so `1.005` in GBP is a validation error rather
 * than a value that later rounds to 101 pence).
 */
export const validateNonNegativePrice = (value: string): string | null =>
  parseOptionalMinorUnits(value) === null
    ? t("fields.validation.price_min")
    : null;

export const validateNonNegativeInteger =
  (label: string) =>
  (value: string): string | null => {
    const n = Number(value);
    return Number.isInteger(n) && n >= 0
      ? null
      : `${label} must be 0 or greater`;
  };

/**
 * Validate email format
 */
export const validateEmail = (value: string): string | null =>
  v.safeParse(EmailFormatSchema, value).success
    ? null
    : t("fields.validation.email");

/**
 * Validate phone number format
 */
const PhoneSchema = v.pipe(
  v.string(),
  // Allow digits, spaces, hyphens, parentheses, plus sign
  v.regex(/^[+\d][\d\s\-()]{5,}$/),
);

export const validatePhone = (value: string): string | null =>
  v.safeParse(PhoneSchema, value).success ? null : t("fields.validation.phone");

/** Validate username format: alphanumeric, hyphens, underscores, 2-32 chars */
const UsernameSchema = v.pipe(
  v.string(),
  v.minLength(2, () => t("fields.validation.username_min")),
  v.maxLength(32, () => t("fields.validation.username_max")),
  v.regex(/^[a-zA-Z0-9_-]+$/, () => t("fields.validation.username_chars")),
  v.check(
    (s) => !s.startsWith("-") && !s.startsWith("_"),
    () => t("fields.validation.username_start"),
  ),
);

export const validateUsername = (value: string): string | null =>
  firstIssueMessage(UsernameSchema, value);

/** Base username field shared across login and invite forms */
export const getUsernameFieldBase = (): InputField<"username"> & {
  required: true;
} => ({
  label: t("common.username"),
  maxlength: 32,
  minlength: 2,
  name: "username",
  pattern: "[a-zA-Z0-9_\\-]+",
  required: true,
  title: t("fields.login.username_title"),
  type: "text",
});

/** Validate listing fields setting (comma-separated contact field names) */
export const validateListingFields = (value: string): string | null => {
  const parts = value
    .split(",")
    .map((v) => v.trim())
    .filter((v) => v);
  for (const part of parts) {
    if (!isContactField(part)) {
      return t("fields.validation.invalid_contact_field", { part });
    }
  }
  return null;
};

/** Validate a built site's update channel (alpha/beta/release) */
export const validateUpdateTier = (value: string): string | null =>
  isUpdateTier(value) ? null : t("fields.validation.update_tier");

/** Check if a string is a valid day name */
const isValidDayName = (s: string): boolean =>
  (VALID_DAY_NAMES as readonly string[]).includes(s);

/**
 * Split a comma-separated string into trimmed, non-empty tokens
 */
export const splitCsv = (value: string): string[] =>
  value
    .split(",")
    .map((d) => d.trim())
    .filter((d) => d);

/** Validate bookable days (comma-separated day names) */
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

/** Validate description length */
const DescriptionSchema = v.pipe(v.string(), v.maxLength(MAX_TEXTAREA_LENGTH));
export const validateDescription = (value: string): string | null =>
  v.safeParse(DescriptionSchema, value).success
    ? null
    : t("fields.validation.description_max", { max: MAX_TEXTAREA_LENGTH });

export const buildDescriptionField = (
  hint: string,
  hintHtml?: string,
): TextareaField<"description"> => ({
  hint,
  ...(hintHtml !== undefined && { hintHtml }),
  label: t("fields.listing.description"),
  markdown: true,
  maxlength: MAX_TEXTAREA_LENGTH,
  name: "description",
  placeholder: t("fields.listing.description_placeholder"),
  type: "textarea",
  validate: validateDescription,
});

/** Validate a datetime value is parseable */
export const validateDatetime = (value: string): string | null =>
  isValidDatetime(value) ? null : t("fields.validation.datetime");

/** Build a "hidden" visibility checkbox field for a listing or group. */
export const buildHiddenField = (
  kind: "Listing" | "Group",
): ChoiceField<"checkbox-group", "1", "hidden"> => ({
  hint:
    kind === "Listing"
      ? t("fields.listing.hidden_hint")
      : t("fields.listing.hidden_hint_group"),
  label:
    kind === "Listing"
      ? t("fields.listing.hidden")
      : t("fields.listing.hidden_group"),
  name: "hidden",
  options: [{ label: t("fields.listing.hidden_label"), value: "1" }],
  type: "checkbox-group",
});

/** Validate date format (YYYY-MM-DD) */
export const validateDate = (value: string): string | null =>
  isIsoDate(value) ? null : t("fields.validation.date");

/** Shared slug field skeleton: name, pattern, validation, label, title.
 * Callers spread this and add their own `hint` (or `publicLinkPath`) on top —
 * the listing/group edit page uses one hint, the SEO content editor another,
 * so each keeps its own copy of just the thing that differs. */
export const slugFieldBase = () =>
  ({
    label: t("common.slug"),
    name: "slug",
    pattern: "[a-z0-9_\\-]+",
    required: true,
    title: t("fields.listing.slug_title"),
    type: "text",
    validate: (value: string) => validateSlug(normalizeSlug(value)),
  }) as const satisfies Field;

/** Slug field for listing/group edit pages */
export const getSlugField = (): InputField<"slug"> => ({
  ...slugFieldBase(),
  hint: t("fields.listing.slug_hint_field"),
});

/** Max length for address field (must fit in payment metadata) */
export const MAX_ADDRESS_LENGTH = 250;

/** Validate address length */
const AddressSchema = v.pipe(v.string(), v.maxLength(MAX_ADDRESS_LENGTH));
export const validateAddress = (value: string): string | null =>
  v.safeParse(AddressSchema, value).success
    ? null
    : t("fields.validation.address_max", { max: MAX_ADDRESS_LENGTH });

/** Max length for special instructions field (must fit in payment metadata) */
export const MAX_SPECIAL_INSTRUCTIONS_LENGTH = 250;

/** Validate special instructions length */
const SpecialInstructionsSchema = v.pipe(
  v.string(),
  v.maxLength(MAX_SPECIAL_INSTRUCTIONS_LENGTH),
);
export const validateSpecialInstructions = (value: string): string | null =>
  v.safeParse(SpecialInstructionsSchema, value).success
    ? null
    : t("fields.validation.special_instructions_max", {
        max: MAX_SPECIAL_INSTRUCTIONS_LENGTH,
      });
