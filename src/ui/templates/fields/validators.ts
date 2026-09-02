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
import { isUpdateTier } from "#db/built-sites/types.ts";
import { t } from "#i18n";
import { VALID_DAY_NAMES } from "#shared/day-names.ts";
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
import { commaParts } from "#shared/split.ts";
import { isValidDatetime } from "#shared/timezone.ts";
import { validateSafeServerFetchUrl } from "#shared/url-safety.ts";
import { isIsoDate } from "#shared/validation/date.ts";
import { EmailFormatSchema } from "#shared/validation/email.ts";
import { parseOptionalMinorUnits } from "#shared/validation/money.ts";
import { isContactField } from "#types";
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

/** Refuses a value the schema turns down, with the message that says why. */
const checkedBy =
  <TSchema extends v.GenericSchema>(
    schema: TSchema,
    messageKey: string,
    values?: Record<string, number>,
  ): ((value: string) => string | null) =>
  (value) =>
    v.is(schema, value) ? null : t(messageKey, values);

/** Refuses text longer than a field allows, naming the limit in the message. */
const atMostLong = (
  max: number,
  messageKey: string,
): ((value: string) => string | null) =>
  checkedBy(v.pipe(v.string(), v.maxLength(max)), messageKey, { max });

/**
 * Validate email format
 */
export const validateEmail = checkedBy(
  EmailFormatSchema,
  "fields.validation.email",
);

/**
 * Validate phone number format
 */
const PhoneSchema = v.pipe(
  v.string(),
  // Allow digits, spaces, hyphens, parentheses, plus sign
  v.regex(/^[+\d][\d\s\-()]{5,}$/),
);

export const validatePhone = checkedBy(PhoneSchema, "fields.validation.phone");

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
  for (const part of commaParts(value)) {
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

/** Validate bookable days (comma-separated day names) */
export const validateBookableDays = (value: string): string | null => {
  const days = commaParts(value);
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
export const validateDescription = atMostLong(
  MAX_TEXTAREA_LENGTH,
  "fields.validation.description_max",
);

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
export const validateAddress = atMostLong(
  MAX_ADDRESS_LENGTH,
  "fields.validation.address_max",
);

/** Max length for special instructions field (must fit in payment metadata) */
export const MAX_SPECIAL_INSTRUCTIONS_LENGTH = 250;

/** Validate special instructions length */
export const validateSpecialInstructions = atMostLong(
  MAX_SPECIAL_INSTRUCTIONS_LENGTH,
  "fields.validation.special_instructions_max",
);
